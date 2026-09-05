import { describe, expect, it } from 'vitest';
import { InMemoryDataStore } from '../../lib/data-store.memory';
import { CRAWL_COLLECTIONS, CRAWL_HISTORY } from './collections';
import { CrawlHistoryStore } from './store';

const RUN_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';

async function open(overrides: Partial<Parameters<typeof CrawlHistoryStore.open>[1]> = {}) {
  const dataStore = new InMemoryDataStore();
  const store = await CrawlHistoryStore.open(dataStore, {
    runId: RUN_ID,
    startedAt: new Date('2026-09-05T10:00:00.000Z'),
    seeds: ['cncf'],
    limit: null,
    repo: null,
    shardCount: 1,
    shardIndex: 0,
    ...overrides,
  });
  return { dataStore, store };
}

describe('CrawlHistoryStore', () => {
  it('ensures its collection so a fresh machine can record a run', async () => {
    const { dataStore } = await open();
    // ensure() is idempotent; calling it again must not throw on an existing collection.
    await expect(dataStore.ensure(CRAWL_COLLECTIONS)).resolves.toBeUndefined();
  });

  it('writes a running document immediately', async () => {
    const { dataStore } = await open();
    const doc = await dataStore.get(CRAWL_HISTORY, RUN_ID);
    expect(doc).toMatchObject({ outcome: 'running', finished_at: null });
  });

  it('stamps the ending on finishRun', async () => {
    const { dataStore, store } = await open();
    await store.finishRun('complete', new Date('2026-09-05T10:05:00.000Z'));
    expect(await dataStore.get(CRAWL_HISTORY, RUN_ID)).toMatchObject({
      outcome: 'complete',
      finished_at: '2026-09-05T10:05:00.000Z',
      duration_ms: 300_000,
    });
  });

  it('records interrupted, which is what the shutdown handler writes', async () => {
    const { dataStore, store } = await open();
    await store.finishRun('interrupted', new Date('2026-09-05T10:01:00.000Z'));
    expect(await dataStore.get(CRAWL_HISTORY, RUN_ID)).toMatchObject({ outcome: 'interrupted' });
  });

  it('records failed', async () => {
    const { dataStore, store } = await open();
    await store.finishRun('failed', new Date('2026-09-05T10:01:00.000Z'));
    expect(await dataStore.get(CRAWL_HISTORY, RUN_ID)).toMatchObject({ outcome: 'failed' });
  });

  it('persists mutated counters', async () => {
    const { dataStore, store } = await open();
    store.counters.repos_fetched += 3;
    store.counters.requests += 9;
    store.counters.points_spent += 7;
    await store.finishRun('complete', new Date('2026-09-05T10:05:00.000Z'));
    expect(await dataStore.get(CRAWL_HISTORY, RUN_ID)).toMatchObject({
      repos_fetched: 3,
      requests: 9,
      points_spent: 7,
    });
  });

  it('collects seed errors', async () => {
    const { dataStore, store } = await open();
    store.recordSeedError('artifacthub', 'HTTP 503');
    await store.finishRun('complete', new Date('2026-09-05T10:05:00.000Z'));
    expect(await dataStore.get(CRAWL_HISTORY, RUN_ID)).toMatchObject({
      seed_errors: [{ name: 'artifacthub', error: 'HTTP 503' }],
    });
  });

  it('is idempotent under a double finish, keeping the first ending', async () => {
    const { dataStore, store } = await open();
    await store.finishRun('interrupted', new Date('2026-09-05T10:01:00.000Z'));
    await store.finishRun('complete', new Date('2026-09-05T10:09:00.000Z'));
    // The shutdown handler and the loop's own finally can both fire. The first ending is the
    // true one: a run that was interrupted did not later complete.
    expect(await dataStore.get(CRAWL_HISTORY, RUN_ID)).toMatchObject({
      outcome: 'interrupted',
      finished_at: '2026-09-05T10:01:00.000Z',
    });
  });
});
