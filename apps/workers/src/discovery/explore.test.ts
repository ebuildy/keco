import { beforeEach, describe, expect, it } from 'vitest';
import type { DataStore } from '../lib/data-store';
import { InMemoryDataStore } from '../lib/data-store.memory';
import { DISCOVERY_COLLECTIONS, REPOS, RUNS, STATE } from './store/collections';
import { applyReset, countDiscovery, listRepos, listRuns, planReset, resolveSort } from './explore';

const seed = async (data: DataStore) => {
  await data.ensure(DISCOVERY_COLLECTIONS);
  await data.put(STATE, [
    {
      query_slug: 'kubernetes',
      query: 'kubernetes',
      pending_windows: [{ base: 'k', stars: '>1', created: null }, { base: 'k', stars: '>2', created: null }],
      updated_at: '2026-08-28T03:14:00.000Z',
    },
    { query_slug: 'istio', query: 'istio', pending_windows: [], updated_at: '2026-08-27T22:01:00.000Z' },
  ]);
  await data.put(REPOS, [
    { id: 'kubernetes_1', repo_id: 1, query_slug: 'kubernetes', stars: 10, full_name: 'a/one', language: 'Go' },
    { id: 'kubernetes_2', repo_id: 2, query_slug: 'kubernetes', stars: 30, full_name: 'a/two', language: 'Go' },
    { id: 'istio_3', repo_id: 3, query_slug: 'istio', stars: 5, full_name: 'b/three', language: 'Rust' },
  ]);
  await data.put(RUNS, [
    { run_id: 'R1', query_slug: 'kubernetes', started_at: '2026-08-27T03:14:00.000Z', outcome: 'complete', repos_new: 2 },
    { run_id: 'R2', query_slug: 'kubernetes', started_at: '2026-08-28T03:14:00.000Z', outcome: 'interrupted', repos_new: 0 },
    { run_id: 'R3', query_slug: 'istio', started_at: '2026-08-27T22:01:00.000Z', outcome: 'complete', repos_new: 1 },
  ]);
};

describe('countDiscovery', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('reports one row per query, ordered by slug for a stable table', async () => {
    const rows = await countDiscovery(data, { query: null });
    expect(rows.map((r) => r.query_slug)).toEqual(['istio', 'kubernetes']);
  });

  it('counts repos, runs and pending windows per query', async () => {
    const [, kubernetes] = await countDiscovery(data, { query: null });
    expect(kubernetes).toMatchObject({
      query: 'kubernetes',
      repos: 2,
      runs: 2,
      pending_windows: 2,
    });
  });

  it('reports the most recent run, not the first', async () => {
    const [, kubernetes] = await countDiscovery(data, { query: null });
    expect(kubernetes!.last_run).toMatchObject({ run_id: 'R2', outcome: 'interrupted' });
  });

  it('narrows to one query when asked', async () => {
    const rows = await countDiscovery(data, { query: 'istio' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ query_slug: 'istio', repos: 1, runs: 1 });
  });

  it('returns an empty list when nothing has been swept', async () => {
    const empty = new InMemoryDataStore();
    await empty.ensure(DISCOVERY_COLLECTIONS);
    expect(await countDiscovery(empty, { query: null })).toEqual([]);
  });

  it('reports a query with state but no runs rather than omitting it', async () => {
    // A sweep killed before its first flush leaves exactly this. Hiding it would hide the
    // thing an operator is looking for.
    await data.put(STATE, [{ query_slug: 'argo', query: 'argo', pending_windows: [] }]);
    const rows = await countDiscovery(data, { query: null });
    expect(rows.find((r) => r.query_slug === 'argo')).toMatchObject({
      repos: 0,
      runs: 0,
      last_run: null,
    });
  });

  it('narrowing to an unswept query returns nothing, not a throw', async () => {
    expect(await countDiscovery(data, { query: 'never-swept' })).toEqual([]);
  });
});

describe('resolveSort', () => {
  it('defaults runs to newest first', () => {
    expect(resolveSort(RUNS, null)).toEqual([['started_at', 'desc']]);
  });

  it('defaults repos to most stars first', () => {
    expect(resolveSort(REPOS, null)).toEqual([['stars', 'desc']]);
  });

  it('accepts a declared sortable field', () => {
    expect(resolveSort(RUNS, 'duration_ms')).toEqual([['duration_ms', 'desc']]);
  });

  it('accepts an explicit direction', () => {
    expect(resolveSort(REPOS, 'stars:asc')).toEqual([['stars', 'asc']]);
  });

  it('rejects an undeclared field by name, listing what is available', () => {
    // Silently ignoring it would show a table that looks sorted and is not.
    expect(() => resolveSort(RUNS, 'nonsense')).toThrow(/nonsense/);
    expect(() => resolveSort(RUNS, 'nonsense')).toThrow(/started_at/);
  });

  it('rejects a direction that is neither asc nor desc', () => {
    expect(() => resolveSort(RUNS, 'started_at:sideways')).toThrow(/sideways/);
  });
});

describe('listRuns', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('returns the newest runs first, across all queries by default', async () => {
    const { rows, total } = await listRuns(data, { query: null, limit: 10, sort: null });
    expect(rows.map((r) => r.run_id)).toEqual(['R2', 'R3', 'R1']);
    expect(total).toBe(3);
  });

  it('narrows to one query', async () => {
    const { rows, total } = await listRuns(data, { query: 'istio', limit: 10, sort: null });
    expect(rows.map((r) => r.run_id)).toEqual(['R3']);
    expect(total).toBe(1);
  });

  it('caps at the limit but still reports the true total', async () => {
    // "showing 2 of 3" is the whole point — a capped table that lies about the total is worse
    // than no table.
    const { rows, total } = await listRuns(data, { query: null, limit: 2, sort: null });
    expect(rows).toHaveLength(2);
    expect(total).toBe(3);
  });
});

describe('listRepos', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('returns the most-starred first', async () => {
    const { rows } = await listRepos(data, { query: null, limit: 10, sort: null });
    expect(rows.map((r) => r.full_name)).toEqual(['a/two', 'a/one', 'b/three']);
  });

  it('caps at the limit and reports the true total', async () => {
    const { rows, total } = await listRepos(data, { query: 'kubernetes', limit: 1, sort: null });
    expect(rows).toHaveLength(1);
    expect(total).toBe(2);
  });
});

describe('planReset', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('refuses with no target rather than defaulting to everything', async () => {
    // A reset that defaults to every query is a reset that eventually runs by accident.
    await expect(planReset(data, { query: null, all: false, includeRuns: false })).rejects.toThrow(
      /--query|--all/,
    );
  });

  it('plans one query when named', async () => {
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: false });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ query_slug: 'kubernetes', repos: 2, state: 1, runs: 2 });
  });

  it('plans every query under --all', async () => {
    const plans = await planReset(data, { query: null, all: true, includeRuns: false });
    expect(plans.map((p) => p.query_slug)).toEqual(['istio', 'kubernetes']);
  });

  it('reports runs as kept by default and deleted under --include-runs', async () => {
    const keep = await planReset(data, { query: 'kubernetes', all: false, includeRuns: false });
    expect(keep[0]!.delete_runs).toBe(false);
    const wipe = await planReset(data, { query: 'kubernetes', all: false, includeRuns: true });
    expect(wipe[0]!.delete_runs).toBe(true);
  });

  it('plans an unswept query as a no-op rather than throwing', async () => {
    const plans = await planReset(data, { query: 'never-swept', all: false, includeRuns: false });
    expect(plans).toEqual([]);
  });
});

describe('applyReset', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('deletes the corpus and state, keeping the run history', async () => {
    // The history is the one collection nothing can reconstruct — not from the cache, not
    // from GitHub — and a reset is when someone most wants to read it.
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: false });
    await applyReset(data, plans);

    expect(await data.count(REPOS, { query_slug: 'kubernetes' })).toBe(0);
    expect(await data.get(STATE, 'kubernetes')).toBeNull();
    expect(await data.count(RUNS, { query_slug: 'kubernetes' })).toBe(2);
  });

  it('deletes the history too under --include-runs', async () => {
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: true });
    await applyReset(data, plans);
    expect(await data.count(RUNS, { query_slug: 'kubernetes' })).toBe(0);
  });

  it('leaves every other query untouched', async () => {
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: true });
    await applyReset(data, plans);
    expect(await data.count(REPOS, { query_slug: 'istio' })).toBe(1);
    expect(await data.get(STATE, 'istio')).not.toBeNull();
  });

  it('is the same deletion --fresh performs', async () => {
    // reset --query X and sweep --fresh must not drift into meaning different things.
    const { DiscoveryStore } = await import('./store/store');
    const other = new InMemoryDataStore();
    await seed(other);

    await applyReset(data, await planReset(data, { query: 'kubernetes', all: false, includeRuns: false }));
    await DiscoveryStore.open(other, 'kubernetes', { runId: 'RUN9', fresh: true });

    expect(await other.count(REPOS, { query_slug: 'kubernetes' })).toBe(
      await data.count(REPOS, { query_slug: 'kubernetes' }),
    );
    expect(await other.get(STATE, 'kubernetes')).toEqual(await data.get(STATE, 'kubernetes'));
  });
});
