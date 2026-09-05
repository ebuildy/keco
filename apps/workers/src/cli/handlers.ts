import { workerLogger } from '../lib/logger';
import type { Handlers } from './program';

/**
 * The real handlers behind `kecoctl`.
 *
 * **Nothing heavy is imported at the top of this file.** Every dependency arrives through a
 * dynamic `import()` inside the handler that needs it. A single static graph would pull
 * `sharp`, the Meilisearch client, the GitHub client and `@keco/analyze` into every invocation —
 * `kecoctl --help` and `kecoctl checkpoint reset` included. Specifiers are extensionless
 * because `moduleResolution` is `bundler` (tsconfig.base.json).
 *
 * That applies to `@keco/search` too, which is easy to get wrong: it was static here at first,
 * and a module-resolution trace showed `meilisearch` loading for all eight commands — including
 * `--help` — while `sharp` and `@keco/analyze` stayed correctly absent. The cost of one more
 * `await import()` in two handlers is smaller than a claim in this comment that is not true.
 *
 * The two `index` commands are implemented here rather than in a worker module because they are
 * operator tooling with no worker behind them: they are the whole of what `engine cli.ts` used
 * to be.
 */
const log = workerLogger('index');

export const handlers: Handlers = {
  discoverySweep: async (options) => {
    const { createDataStore } = await import('./data-store');
    return (await import('../discovery')).runDiscovery(options, { dataStore: createDataStore() });
  },
  repoCrawl: async (options) => (await import('../crawler')).runCrawler(options),
  repoAnalyze: async (options) => (await import('../analyzer')).runAnalyzer(options),
  repoIcon: async (options) => (await import('../crawler/icon-run')).runIcon(options),
  project: async (options) => (await import('../projector')).runProjector(options),
  checkpointReset: async (options) => (await import('../replay')).runCheckpointReset(options),

  indexCreate: async ({ host, index: uid, forceSettings }) => {
    const { createAdminClient } = await import('@keco/search');
    const { createIndex } = await import('../read-model/create-index');

    // `--host` overrides MEILI_HOST for a one-off run.
    const plan = await createIndex(
      createAdminClient({ ...process.env, MEILI_HOST: host }),
      uid,
      forceSettings,
    );

    log.info(
      { index: uid, host, ...plan },
      plan.applySettings ? 'index ready' : 'settings not applied',
    );
    if (!plan.applySettings && !plan.create) {
      // Nothing was broken, but nothing was done either — say so loudly enough to be noticed
      // in a deploy log, and leave the exit code at 0 so a bootstrap step stays idempotent.
      log.warn({ index: uid }, plan.reason);
    }
  },

  indexSeed: async ({ host, index: uid, batch, clear, force }) => {
    const { awaitTask, createAdminClient } = await import('@keco/search');
    const { loadCorpus, MOCK_CORPUS_PATH } = await import('../read-model/corpus');
    const { readIndexState } = await import('../read-model/create-index');
    const { assertSeedTarget, seedDocuments } = await import('../read-model/seed');

    // Before anything is read or connected: seeding fabricated install_methods into a real
    // corpus is the worst bug this project can ship (§6).
    assertSeedTarget(host, force);

    const documents = await loadCorpus();
    const client = createAdminClient({ ...process.env, MEILI_HOST: host });

    // Settings are what make a seeded index worth searching — facets, ranking, sorts. Refuse to
    // fill an unconfigured index rather than quietly producing a corpus with none of them.
    if (!(await readIndexState(client, uid)).exists) {
      throw new Error(`no index "${uid}" at ${host} — run \`kecoctl index create\` first`);
    }

    log.info(
      { index: uid, host, documents: documents.length, source: MOCK_CORPUS_PATH, batch },
      'seeding mock corpus',
    );

    if (clear) {
      await awaitTask(client.index(uid).deleteAllDocuments());
      log.info({ index: uid }, 'cleared existing documents');
    }

    const sent = await seedDocuments(documents, {
      batchSize: batch,
      // Await the task, not the enqueue: a resolved `addDocuments` only means Meilisearch
      // accepted the batch, and a failed task after that would go unnoticed (§5, §14).
      submit: (chunk) => awaitTask(client.index(uid).addDocuments(chunk)),
      onBatch: (batchNumber, documentsSent) =>
        log.debug(
          { batch: batchNumber, sent: documentsSent, of: documents.length },
          'batch indexed',
        ),
    });

    const stats = await client.index(uid).getStats();
    log.info(
      { index: uid, sent, documentsInIndex: stats.numberOfDocuments },
      'mock corpus seeded — fabricated data, never a production index',
    );
  },
};
