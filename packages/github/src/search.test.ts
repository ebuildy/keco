import { describe, expect, it, vi } from 'vitest';
import { RatePacer, SearchClient } from './search';

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

/** A fake clock whose sleep advances it, so pacing is testable without real time. */
const fakeClock = () => {
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
    const pacer = new RatePacer(2000, clock.now, clock.sleep);

    await pacer.wait();
    expect(clock.elapsed).toBe(0); // the first call never waits

    await pacer.wait();
    expect(clock.elapsed).toBe(2000);

    await pacer.wait();
    expect(clock.elapsed).toBe(4000);
  });

  it('does not wait when the caller was already slow', async () => {
    const clock = fakeClock();
    const pacer = new RatePacer(2000, clock.now, clock.sleep);

    await pacer.wait();
    await clock.sleep(9000); // caller spent 9s doing other work
    await pacer.wait();

    expect(clock.elapsed).toBe(9000); // no extra sleep was added
  });
});

describe('SearchClient', () => {
  it('parses a page and drops fields we do not model', async () => {
    const transport = vi.fn().mockResolvedValue({
      total_count: 1,
      incomplete_results: false,
      items: [item({ assignees_url: 'https://api.github.com/…' })],
    });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    const page = await client.page('kubernetes stars:>5000', 1);

    expect(page.total_count).toBe(1);
    expect(page.items[0]!.full_name).toBe('ahmetb/kubectx');
    expect(page.items[0]).not.toHaveProperty('assignees_url');
    expect(transport).toHaveBeenCalledWith({
      q: 'kubernetes stars:>5000',
      per_page: 100,
      page: 1,
    });
  });

  it('tolerates the nulls GitHub really returns', async () => {
    const transport = vi.fn().mockResolvedValue({
      total_count: 1,
      incomplete_results: false,
      items: [item({ description: null, license: null, language: null, homepage: null })],
    });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    const page = await client.page('kubernetes', 1);

    expect(page.items[0]!.license).toBeNull();
    expect(page.items[0]!.description).toBeNull();
  });

  it('retries a 403 and honours retry-after', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), {
      status: 403,
      response: { headers: { 'retry-after': '7' } },
    });
    const transport = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValue({ total_count: 0, incomplete_results: false, items: [] });

    const client = new SearchClient(transport, {
      minIntervalMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    await client.page('kubernetes', 1);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(clock.elapsed).toBe(7000); // retry-after wins over exponential backoff
  });

  it('gives up after maxRetries', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), { status: 429 });
    const transport = vi.fn().mockRejectedValue(throttled);
    const client = new SearchClient(transport, {
      minIntervalMs: 0,
      maxRetries: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    await expect(client.page('kubernetes', 1)).rejects.toThrow('rate limited');
    expect(transport).toHaveBeenCalledTimes(3); // the first try plus two retries
  });

  it('does not retry a malformed payload', async () => {
    const transport = vi.fn().mockResolvedValue({ total_count: 'lots', items: [] });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    await expect(client.page('kubernetes', 1)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
