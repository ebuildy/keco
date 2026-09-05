import type { SearchItem } from '@keco/github';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataStore } from '../../lib/data-store';
import { InMemoryDataStore } from '../../lib/data-store.memory';
import { REPOS, RUNS, STATE } from './collections';
import { DiscoveryStore } from './store';

const item = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    id: 20038725,
    full_name: 'ahmetb/kubectx',
    name: 'kubectx',
    owner: { login: 'ahmetb' },
    description: 'Faster way to switch between clusters',
    homepage: null,
    stargazers_count: 18234,
    forks_count: 1180,
    open_issues_count: 41,
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
    topics: ['kubectl'],
    archived: false,
    fork: false,
    default_branch: 'master',
    created_at: '2014-05-22T12:00:00Z',
    updated_at: '2026-07-20T08:11:00Z',
    pushed_at: '2026-07-14T19:02:00Z',
    ...overrides,
  }) as SearchItem;

const open = (data: DataStore, options: Parameters<typeof DiscoveryStore.open>[2] = {}) =>
  DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1', ...options });

const collect = async (iterable: AsyncIterable<Record<string, unknown>>) => {
  const out: Record<string, unknown>[] = [];
  for await (const row of iterable) out.push(row);
  return out;
};

describe('DiscoveryStore', () => {
  let data: DataStore;
  beforeEach(() => {
    data = new InMemoryDataStore();
  });

  it('records a new repo and writes it on flush, not before', async () => {
    const store = await open(data);
    expect(await store.record(item(), 'q')).toBe('new');
    // Buffered: a write per repo is a round-trip per repo against a real backend.
    expect(await data.count(REPOS)).toBe(0);

    await store.flush();
    expect(await data.count(REPOS)).toBe(1);
    const [doc] = await collect(data.list(REPOS));
    expect(doc).toMatchObject({
      id: 'kubernetes_20038725',
      repo_id: 20038725,
      query_slug: 'kubernetes',
      first_seen_run_id: 'RUN1',
      last_seen_run_id: 'RUN1',
    });
  });

  it('reports a repo already seen in this run as unchanged, without rewriting it', async () => {
    const store = await open(data);
    await store.record(item(), 'kubernetes');
    // A window over 1000 results contributes its probe items and then subdivides, so its
    // children re-yield the same repos. First window wins.
    expect(await store.record(item(), 'kubernetes created:2020..2021')).toBe('unchanged');
    await store.flush();

    const [doc] = await collect(data.list(REPOS));
    expect(doc!.discovered_via).toBe('kubernetes');
  });

  it('counts distinct known repos in size', async () => {
    const store = await open(data);
    await store.record(item(), 'q');
    await store.record(item({ id: 99, full_name: 'a/b', name: 'b' }), 'q');
    await store.record(item(), 'q');
    expect(store.size).toBe(2);
  });

  it('resumes: an unchanged payload is not rewritten on the next run', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    first.state.completed_windows.push('q');
    await first.flush();

    const second = await open(data, { runId: 'RUN2' });
    expect(second.size).toBe(1);
    expect(await second.record(item(), 'q')).toBe('unchanged');
    expect(second.state.completed_windows).toEqual(['q']);
  });

  it('resumes: a changed payload is rewritten, keeping its first_seen_run_id', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    first.state.completed_windows.push('q');
    await first.flush();

    const second = await open(data, { runId: 'RUN2' });
    expect(await second.record(item({ stargazers_count: 20000 }), 'q')).toBe('changed');
    await second.flush();

    const [doc] = await collect(data.list(REPOS));
    expect(doc).toMatchObject({
      stars: 20000,
      first_seen_run_id: 'RUN1',
      last_seen_run_id: 'RUN2',
    });
  });

  it('starts cold when there is no state, even if repo documents exist', async () => {
    // State is what says how far a sweep got; the corpus carries no progress of its own.
    // Loading a corpus whose progress this run cannot account for is worse than resweeping.
    await data.ensure((await import('./collections')).DISCOVERY_COLLECTIONS);
    await data.put(REPOS, [
      { id: 'kubernetes_1', repo_id: 1, query_slug: 'kubernetes', payload_hash: 'h' },
    ]);
    const store = await open(data);
    expect(store.size).toBe(0);
  });

  it('--fresh deletes this query, and only this query', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    await first.flush();
    await data.put(REPOS, [{ id: 'istio_7', repo_id: 7, query_slug: 'istio', payload_hash: 'h' }]);

    const second = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2', fresh: true });
    expect(second.size).toBe(0);
    expect(await data.count(REPOS, { query_slug: 'kubernetes' })).toBe(0);
    expect(await data.count(REPOS, { query_slug: 'istio' })).toBe(1);
    expect(await data.get(STATE, 'kubernetes')).toBeNull();
  });

  it('degrades to a fresh sweep when state fails validation, rather than wedging', async () => {
    const warnings: object[] = [];
    await data.ensure((await import('./collections')).DISCOVERY_COLLECTIONS);
    await data.put(STATE, [{ query_slug: 'kubernetes', query: 'kubernetes', pending_windows: 'no' }]);

    const store = await open(data, { logger: { warn: (fields) => warnings.push(fields) } });
    expect(store.size).toBe(0);
    expect(store.state.completed_windows).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('drops an unparseable corpus row without losing the rest', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    await first.flush();
    await data.put(REPOS, [{ id: 'kubernetes_5', query_slug: 'kubernetes' }]); // no payload_hash

    const second = await open(data, { runId: 'RUN2' });
    expect(second.size).toBe(1);
  });

  it('writes the corpus before the state document', async () => {
    // The ordering guarantee: state must never claim windows whose repos are not written.
    const order: string[] = [];
    // Delegate explicitly rather than spreading `data`: it is a class instance, so a spread
    // copies its private Maps and none of its methods.
    const spy: DataStore = {
      ensure: (specs) => data.ensure(specs),
      get: (c, id) => data.get(c, id),
      count: (c, w) => data.count(c, w),
      list: (c, q) => data.list(c, q),
      remove: (c, w) => data.remove(c, w),
      put: (c, d, o) => {
        order.push(`${c}${o?.durable === true ? ':durable' : ''}`);
        return data.put(c, d, o);
      },
    };
    const store = await DiscoveryStore.open(spy, 'kubernetes', { runId: 'RUN1' });
    order.length = 0;
    await store.record(item(), 'q');
    await store.flush();
    expect(order).toEqual([REPOS, `${STATE}:durable`]);
  });

  it('flushes on the 25th window, not before', async () => {
    const store = await open(data);
    const now = new Date('2026-08-29T00:00:00Z');
    for (let i = 1; i < 25; i += 1) {
      expect(await store.windowCompleted(now)).toBe(false);
    }
    expect(await store.windowCompleted(now)).toBe(true);
  });

  it('flushes once 30 seconds have passed, however few windows completed', async () => {
    const store = await open(data, { now: new Date('2026-08-29T00:00:00Z') });
    expect(await store.windowCompleted(new Date('2026-08-29T00:00:29Z'))).toBe(false);
    expect(await store.windowCompleted(new Date('2026-08-29T00:00:30Z'))).toBe(true);
  });

  it('serialises overlapping flushes', async () => {
    // The shutdown handler's flush and the loop's can be in flight at once; interleaving them
    // can persist a state that marks a window complete alongside a corpus missing its repos.
    const store = await open(data);
    await store.record(item(), 'q');
    await Promise.all([store.flush(), store.flush(), store.flush()]);
    expect(await data.count(REPOS)).toBe(1);
  });

  it('one failed flush does not poison every later one', async () => {
    let failNext = true;
    const spy: DataStore = {
      ensure: (specs) => data.ensure(specs),
      get: (c, id) => data.get(c, id),
      count: (c, w) => data.count(c, w),
      list: (c, q) => data.list(c, q),
      remove: (c, w) => data.remove(c, w),
      put: (c, d, o) => {
        if (c === REPOS && failNext) {
          failNext = false;
          return Promise.reject(new Error('backend down'));
        }
        return data.put(c, d, o);
      },
    };
    const store = await DiscoveryStore.open(spy, 'kubernetes', { runId: 'RUN1' });
    await store.record(item(), 'q');
    await expect(store.flush()).rejects.toThrow('backend down');
    await expect(store.flush()).resolves.toBeUndefined();
  });
});

describe('DiscoveryStore run history', () => {
  let data: DataStore;
  beforeEach(() => {
    data = new InMemoryDataStore();
  });

  it('writes a running record the moment the store opens', async () => {
    await DiscoveryStore.open(data, 'kubernetes', {
      runId: 'RUN1',
      now: new Date('2026-08-29T03:00:00Z'),
      fresh: true,
      limit: 500,
    });

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({
      run_id: 'RUN1',
      query: 'kubernetes',
      query_slug: 'kubernetes',
      started_at: '2026-08-29T03:00:00.000Z',
      outcome: 'running',
      ended_at: null,
      duration_ms: null,
      fresh: true,
      limit: 500,
    });
  });

  it('generates a sortable run id when none is injected', async () => {
    const store = await DiscoveryStore.open(data, 'kubernetes', {});
    expect(store.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('finishRun stamps the ending and the run-scoped counters', async () => {
    const store = await DiscoveryStore.open(data, 'kubernetes', {
      runId: 'RUN1',
      now: new Date('2026-08-29T03:00:00Z'),
    });
    await store.record(item(), 'q');
    await store.record(item({ id: 2, full_name: 'a/b', name: 'b' }), 'q');
    await store.record(item(), 'q'); // already seen this run
    store.state.pages_fetched += 7;
    store.state.dropped += 1;
    store.state.completed_windows.push('w1', 'w2');

    await store.finishRun('complete', new Date('2026-08-29T04:12:00Z'));

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({
      outcome: 'complete',
      ended_at: '2026-08-29T04:12:00.000Z',
      duration_ms: 72 * 60 * 1000,
      repos_new: 2,
      repos_unchanged: 1,
      pages_fetched: 7,
      dropped: 1,
      windows_completed: 2,
      sweep_repos_total: 2,
    });
  });

  it('reports pages this run, not the sweep total carried in from a resume', async () => {
    const first = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    first.state.pages_fetched = 600;
    first.state.completed_windows.push('w1');
    await first.flush();
    await first.finishRun('interrupted');

    const second = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2' });
    expect(second.state.pages_fetched).toBe(600); // sweep-scoped, carried in
    second.state.pages_fetched += 42;
    await second.finishRun('complete');

    const run = await data.get(RUNS, 'RUN2');
    expect(run).toMatchObject({ pages_fetched: 42, sweep_windows_pending: 0 });
  });

  it('counts windows completed by this run, not by the sweep', async () => {
    const first = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    first.state.completed_windows.push('w1', 'w2', 'w3');
    await first.flush();
    await first.finishRun('interrupted');

    const second = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2' });
    second.state.completed_windows.push('w4');
    await second.finishRun('complete');

    expect(await data.get(RUNS, 'RUN2')).toMatchObject({ windows_completed: 1 });
  });

  it('records failed windows and the stopped-at-limit flag', async () => {
    const store = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    store.state.failed_windows.push({ window: 'w', error: 'boom' });
    await store.finishRun('failed', undefined, { stoppedAtLimit: true });

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({
      outcome: 'failed',
      windows_failed: 1,
      stopped_at_limit: true,
      failed_windows: [{ window: 'w', error: 'boom' }],
    });
  });

  it('leaves a killed run at running, rather than rewriting history', async () => {
    // A SIGKILL never reaches finishRun. The stuck row IS the signal that a sweep died
    // without cleanup — quietly repairing it would hide the failure someone is looking for.
    await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    const later = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2' });
    await later.finishRun('complete');

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({ outcome: 'running' });
    expect(await data.count(RUNS)).toBe(2);
  });

  it('--fresh keeps the run history, which nothing else can reconstruct', async () => {
    await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2', fresh: true });
    expect(await data.count(RUNS, { query_slug: 'kubernetes' })).toBe(2);
  });
});
