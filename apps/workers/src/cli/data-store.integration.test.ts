import { createAdminClient } from '@keco/search';
import { afterAll, describe, expect, it } from 'vitest';
import { describeDataStore } from '../lib/data-store.conformance';
import { MeilisearchDataStore } from './data-store';

/**
 * Runs against the compose Meilisearch. Skipped unless MEILI_INTEGRATION=1, so `mise run ci`
 * stays hermetic — this is a `mise run test:integration` gate, not part of the default run.
 *
 * The conformance suite creates its collections under names prefixed for this file, and
 * afterAll deletes them. Meilisearch has no transactions and no per-test teardown, so the
 * suite is written to be run serially against a development instance — do not point
 * MEILI_HOST at anything you care about.
 */
const enabled = process.env.MEILI_INTEGRATION === '1';
const client = createAdminClient();

/** Named apart from anything a developer would create by hand. */
const PREFIX = 'it_datastore_';
const collections = [`${PREFIX}widgets`, `${PREFIX}notes`, `${PREFIX}durable`];

describe.skipIf(!enabled)('MeilisearchDataStore', () => {
  afterAll(async () => {
    for (const uid of collections) {
      await client.deleteIndex(uid).waitTask().catch(() => null);
    }
  });

  describeDataStore(
    'MeilisearchDataStore',
    async () => ({
      store: new MeilisearchDataStore(client),
      // The fs and memory harnesses hand each test a brand-new, empty backing store; this one
      // is a real shared index that survives between tests, so isolation has to be restored
      // explicitly. `close` runs after every test (see `withStore` in the conformance suite) —
      // clear documents, not the index itself, so `ensure()`'s settings comparison keeps
      // short-circuiting instead of reindexing on every single test.
      close: async () => {
        await client.index(`${PREFIX}widgets`).deleteAllDocuments().waitTask();
        await client.index(`${PREFIX}notes`).deleteAllDocuments().waitTask();
      },
    }),
    PREFIX,
  );

  it('a durable put confirms every earlier put, not just its own task', async () => {
    const uid = `${PREFIX}durable`;
    const store = new MeilisearchDataStore(client);
    await store.ensure([{ name: uid, primaryKey: 'id', filterable: ['kind'] }]);
    await store.remove(uid, { kind: 'repo' }).catch(() => null);

    // Corpus-shaped write: enqueued, deliberately not waited on.
    await store.put(uid, Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, kind: 'repo' })));
    // State-shaped write: durable. When this resolves the 500 must already be readable.
    await store.put(uid, [{ id: 'state', kind: 'state' }], { durable: true });

    expect(await store.count(uid, { kind: 'repo' })).toBe(500);
  });
});
