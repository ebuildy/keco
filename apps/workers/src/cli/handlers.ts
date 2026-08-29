import { awaitTask, createAdminClient } from '@keco/search';
import { workerLogger } from '../lib/logger';
import { loadCorpus, MOCK_CORPUS_PATH } from '../read-model/corpus';
import { createIndex, readIndexState } from '../read-model/create-index';
import { assertSeedTarget, seedDocuments } from '../read-model/seed';
import type { Handlers } from './program';

/**
 * The real handlers behind `kecoctl`.
 *
 * Every worker is loaded with a dynamic `import()` rather than a static one. A single static
 * graph would pull `sharp`, the Meilisearch client, the GitHub client and `@keco/analyze` into
 * every invocation — `kecoctl --help` and `kecoctl checkpoint reset` included. Specifiers are
 * extensionless because `moduleResolution` is `bundler` (tsconfig.base.json).
 *
 * The two `index` commands are implemented here rather than in a worker module because they are
 * operator tooling with no worker behind them: they are the whole of what `engine cli.ts` used
 * to be.
 */
const log = workerLogger('engine');

/** Every command talks to one Meilisearch; `--host` overrides MEILI_HOST for a one-off run. */
const clientFor = (host: string) => createAdminClient({ ...process.env, MEILI_HOST: host });

export const handlers: Handlers = {
  discoverySweep: async (options) => (await import('../discovery')).runDiscovery(options),
  repoCrawl: async (options) => (await import('../crawler')).runCrawler(options),
  repoAnalyze: async (options) => (await import('../analyzer')).runAnalyzer(options),
  repoIcon: async (options) => (await import('../crawler/icon-run')).runIcon(options),
  project: async (options) => (await import('../projector')).runProjector(options),
  checkpointReset: async (options) => (await import('../replay')).runCheckpointReset(options),

  indexCreate: async ({ host, index: uid, forceSettings }) => {
    const plan = await createIndex(clientFor(host), uid, forceSettings);

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
    assertSeedTarget(host, force);

    const documents = await loadCorpus();
    const client = clientFor(host);

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
