import { beforeEach, describe, expect, it } from 'vitest';
import type { DataStore } from '../lib/data-store';
import { InMemoryDataStore } from '../lib/data-store.memory';
import { DISCOVERY_COLLECTIONS, REPOS, RUNS, STATE } from './store/collections';
import { countDiscovery } from './explore';

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
