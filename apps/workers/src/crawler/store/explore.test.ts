import { describe, expect, it } from 'vitest';
import { InMemoryDataStore } from '../../lib/data-store.memory';
import { CRAWL_COLLECTIONS, CRAWL_HISTORY } from './collections';
import { formatHistory, listCrawls } from './explore';

async function store(rows: Record<string, unknown>[]) {
  const dataStore = new InMemoryDataStore();
  await dataStore.ensure(CRAWL_COLLECTIONS);
  if (rows.length > 0) await dataStore.put(CRAWL_HISTORY, rows);
  return dataStore;
}

const row = (over: Record<string, unknown> = {}) => ({
  run_id: '01K4A',
  started_at: '2026-09-05T10:00:00.000Z',
  finished_at: '2026-09-05T10:05:00.000Z',
  duration_ms: 300_000,
  outcome: 'complete',
  seeds: ['cncf'],
  limit: 200,
  repo: null,
  shard_count: 1,
  shard_index: 0,
  repos_seen: 10, repos_fetched: 8, repos_unchanged: 1, repos_skipped: 1,
  repos_failed: 0, icons_updated: 6, requests: 40, points_spent: 33, rate_limited: 0,
  seed_errors: [],
  ...over,
});

describe('listCrawls', () => {
  it('returns the newest run first', async () => {
    const dataStore = await store([
      row({ run_id: '01K4A', started_at: '2026-09-05T10:00:00.000Z' }),
      row({ run_id: '01K4B', started_at: '2026-09-06T10:00:00.000Z' }),
    ]);
    const result = await listCrawls(dataStore, { limit: 10 });
    expect(result.rows.map((r) => r.run_id)).toEqual(['01K4B', '01K4A']);
  });

  it('honours the limit', async () => {
    const dataStore = await store([row({ run_id: 'a' }), row({ run_id: 'b' }), row({ run_id: 'c' })]);
    expect((await listCrawls(dataStore, { limit: 2 })).rows).toHaveLength(2);
  });

  it('ensures the collection, so a fresh machine does not throw', async () => {
    const dataStore = new InMemoryDataStore();
    await expect(listCrawls(dataStore, { limit: 10 })).resolves.toMatchObject({ rows: [] });
  });
});

describe('formatHistory', () => {
  it('renders a table with the columns an operator reads', async () => {
    const output = formatHistory({ rows: [row()] });
    for (const heading of ['RUN', 'STARTED', 'OUTCOME', 'FETCHED', 'UNCHANGED', 'SKIPPED', 'FAILED', 'POINTS']) {
      expect(output).toContain(heading);
    }
  });

  it('shows a running run with no duration rather than a zero', async () => {
    const output = formatHistory({
      rows: [row({ outcome: 'running', finished_at: null, duration_ms: null })],
    });
    expect(output).toContain('running');
    expect(output).toContain('—');
  });

  it('flags seed errors, which is the whole reason they are recorded', async () => {
    const output = formatHistory({
      rows: [row({ seed_errors: [{ name: 'artifacthub', error: 'HTTP 503' }] })],
    });
    expect(output).toContain('artifacthub');
  });

  it('renders an empty history as a sentence, not an empty table', () => {
    expect(formatHistory({ rows: [] })).toContain('no crawl');
  });
});
