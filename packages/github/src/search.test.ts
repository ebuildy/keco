import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RatePacer, SearchClient, type Clock } from './search';

/** Stubs the one production construction path so `fromToken` is testable without a network. */
const reposMock = vi.fn();
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(function FakeOctokit() {
    return { rest: { search: { repos: reposMock } } };
  }),
}));

/** One well-formed search item; tests override only the fields they care about. */
const item = (overrides: Record<string, unknown> = {}) => ({
  id: 20038725,
  full_name: 'ahmetb/kubectx',
  name: 'kubectx',
  owner: { login: 'ahmetb' },
  description: 'Faster way to switch between clusters',
  homepage: 'https://kubectx.dev',
  stargazers_count: 18234,
  forks_count: 1180,
  open_issues_count: 41,
  language: 'Go',
  license: { spdx_id: 'Apache-2.0' },
  topics: ['kubernetes', 'kubectl'],
  archived: false,
  fork: false,
  default_branch: 'master',
  created_at: '2014-05-22T12:00:00Z',
  updated_at: '2026-07-20T08:11:00Z',
  pushed_at: '2026-07-14T19:02:00Z',
  ...overrides,
});

const page = (items: unknown[], overrides: Record<string, unknown> = {}) => ({
  total_count: items.length,
  incomplete_results: false,
  items,
  ...overrides,
});

/** A fake clock whose sleep advances it, so pacing is testable without real time. */
const fakeClock = (): Clock & { elapsed: number } => {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (delay: number) => {
      ms += delay;
    },
    get elapsed() {
      return ms;
    },
  };
};

describe('RatePacer', () => {
  it('spaces calls by the minimum interval', async () => {
    const clock = fakeClock();
    const pacer = new RatePacer(2000, clock);

    await pacer.wait();
    expect(clock.elapsed).toBe(0); // the first call never waits

    await pacer.wait();
    expect(clock.elapsed).toBe(2000);

    await pacer.wait();
    expect(clock.elapsed).toBe(4000);
  });

  it('does not wait when the caller was already slow, and resumes pacing after', async () => {
    const clock = fakeClock();
    const pacer = new RatePacer(2000, clock);

    await pacer.wait();
    await clock.sleep(9000); // caller spent 9s doing other work
    await pacer.wait();

    expect(clock.elapsed).toBe(9000); // no extra sleep was added

    // A pacer that does `nextAllowedAt += interval` instead of `= now() + interval` would
    // fire this third call immediately; the correct one still waits the full interval.
    await pacer.wait();
    expect(clock.elapsed).toBe(11000);
  });

  it('penalise pushes nextAllowedAt out for whichever call is next, not just the current one', async () => {
    const clock = fakeClock();
    const pacer = new RatePacer(2000, clock);

    await pacer.wait(); // nextAllowedAt = 2000
    pacer.penalise(50_000); // a throttle discovered after this call already went out

    await pacer.wait();
    expect(clock.elapsed).toBe(50_000); // the penalty wins over the ordinary 2s cadence

    pacer.penalise(1000); // a smaller penalty than what's already scheduled changes nothing
    await pacer.wait();
    expect(clock.elapsed).toBe(52_000); // 50_000 + the ordinary interval
  });
});

describe('SearchClient', () => {
  it('parses a page and drops fields we do not model', async () => {
    const transport = vi.fn().mockResolvedValue({
      data: page([item({ assignees_url: 'https://api.github.com/…' })]),
      headers: {},
    });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    const result = await client.page('kubernetes stars:>5000', 1);

    expect(result.total_count).toBe(1);
    expect(result.items[0]!.full_name).toBe('ahmetb/kubectx');
    expect(result.items[0]).not.toHaveProperty('assignees_url');
    expect(transport).toHaveBeenCalledWith({
      q: 'kubernetes stars:>5000',
      per_page: 100,
      page: 1,
    });
  });

  it('tolerates the nulls GitHub really returns', async () => {
    const transport = vi.fn().mockResolvedValue({
      data: page([item({ description: null, license: null, language: null, homepage: null })]),
      headers: {},
    });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    const result = await client.page('kubernetes', 1);

    expect(result.items[0]!.license).toBeNull();
    expect(result.items[0]!.description).toBeNull();
  });

  it('drops malformed items but keeps the good ones on the same page', async () => {
    const transport = vi.fn().mockResolvedValue({
      data: page([
        item(),
        { id: 'not-a-number' }, // fails the schema entirely
        item({ full_name: 'other/repo', name: 'repo', id: 999 }),
      ]),
      headers: {},
    });
    const logger = { warn: vi.fn() };
    const client = new SearchClient(transport, { minIntervalMs: 0, logger });

    const result = await client.page('kubernetes', 1);

    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.full_name)).toEqual(['ahmetb/kubectx', 'other/repo']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: 1, total: 3 }),
      expect.stringContaining('dropped'),
    );
  });

  it('does not retry a malformed page envelope, and never fabricates missing fields', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue({ data: { total_count: 'lots', items: [] }, headers: {} });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    await expect(client.page('kubernetes', 1)).rejects.toThrow(z.ZodError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects a page/perPage combination beyond the 1000-result cap without spending a call', async () => {
    const transport = vi.fn();
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    await expect(client.page('kubernetes', 11, 100)).rejects.toThrow(/1000-result cap/);
    await expect(client.page('kubernetes', 1, 101)).rejects.toThrow(/perPage/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('retries a 403 and honours retry-after, with pacing enabled', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), {
      status: 403,
      response: { headers: { 'retry-after': '7' } },
    });
    const transport = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValue({ data: page([]), headers: {} });

    const client = new SearchClient(transport, { minIntervalMs: 2000, clock });

    await client.page('kubernetes', 1);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(clock.elapsed).toBe(7000); // retry-after (7s) dominates the 2s pacing interval
  });

  it('floors an unheadered 403 at 60s, not the ~1s exponential backoff', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), {
      status: 403,
      response: { headers: {} },
    });
    const transport = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValue({ data: page([]), headers: {} });

    const client = new SearchClient(transport, { minIntervalMs: 0, clock });

    await client.page('kubernetes', 1);

    expect(clock.elapsed).toBe(60_000);
  });

  it('waits until the absolute x-ratelimit-reset instant when retry-after is absent', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), {
      status: 403,
      response: { headers: { 'x-ratelimit-reset': '5' } }, // 5s on the fake clock's own epoch
    });
    const transport = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValue({ data: page([]), headers: {} });

    const client = new SearchClient(transport, { minIntervalMs: 0, clock });

    await client.page('kubernetes', 1);

    expect(clock.elapsed).toBe(5000);
  });

  it('penalise persists after a call gives up, delaying the next call too', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), {
      status: 403,
      response: { headers: {} },
    });
    const transport = vi.fn().mockRejectedValue(throttled);
    const client = new SearchClient(transport, { minIntervalMs: 0, maxRetries: 0, clock });

    await expect(client.page('kubernetes', 1)).rejects.toThrow('rate limited');
    expect(clock.elapsed).toBe(0); // gave up without ever sleeping itself

    transport.mockResolvedValue({ data: page([]), headers: {} });
    await client.page('kubernetes', 1);

    expect(clock.elapsed).toBe(60_000); // the second call paid the penalty the first left behind
  });

  it('gives up after maxRetries on a throttle', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), {
      status: 429,
      response: { headers: {} },
    });
    const transport = vi.fn().mockRejectedValue(throttled);
    const client = new SearchClient(transport, { minIntervalMs: 0, maxRetries: 2, clock });

    await expect(client.page('kubernetes', 1)).rejects.toThrow('rate limited');
    expect(transport).toHaveBeenCalledTimes(3); // the first try plus two retries
  });

  it('retries a status-500 transient failure with plain exponential backoff', async () => {
    // @octokit/request wraps every network failure (ECONNRESET, ETIMEDOUT, a hung socket)
    // as a RequestError with status 500 — this is the case a 403/429-only retry policy misses.
    const wrappedNetworkFailure = Object.assign(new Error('request failed'), { status: 500 });
    const transport = vi
      .fn()
      .mockRejectedValueOnce(wrappedNetworkFailure)
      .mockResolvedValue({ data: page([]), headers: {} });

    const client = new SearchClient(transport, { minIntervalMs: 0 });

    await client.page('kubernetes', 1);

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('retries real 502/503/504 from Search under load', async () => {
    for (const status of [502, 503, 504]) {
      const transport = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status }))
        .mockResolvedValue({ data: page([]), headers: {} });
      const client = new SearchClient(transport, { minIntervalMs: 0 });

      await client.page('kubernetes', 1);

      expect(transport).toHaveBeenCalledTimes(2);
    }
  });

  it('retries a network failure that carries no status at all', async () => {
    // What @octokit/request throws for ECONNRESET / ETIMEDOUT / a socket hang-up: a plain
    // Error with no .status property.
    const socketHangUp = new Error('socket hang up');
    const transport = vi
      .fn()
      .mockRejectedValueOnce(socketHangUp)
      .mockResolvedValue({ data: page([]), headers: {} });

    const client = new SearchClient(transport, { minIntervalMs: 0 });

    await client.page('kubernetes', 1);

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404', async () => {
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    const transport = vi.fn().mockRejectedValue(notFound);
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    await expect(client.page('kubernetes', 1)).rejects.toThrow('not found');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('fromToken wires Octokit search.repos through as { data, headers }', async () => {
    reposMock.mockResolvedValue({
      data: page([]),
      headers: { 'x-ratelimit-remaining': '29' },
    });

    const client = SearchClient.fromToken('fake-token', { minIntervalMs: 0 });
    const result = await client.page('kubernetes', 1);

    expect(result.total_count).toBe(0);
    expect(reposMock).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'kubernetes', per_page: 100, page: 1 }),
    );
  });
});
