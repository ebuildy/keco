import { Command, InvalidArgumentError } from 'commander';
import { awaitTask, createAdminClient, TOOLS_ALIAS } from '@keco/search';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { loadCorpus, MOCK_CORPUS_PATH } from './corpus';
import { createIndex, readIndexState } from './create-index';
import { assertSeedTarget, seedDocuments } from './seed';

/**
 * `engine` — the Meilisearch read-model CLI (AGENTS.md §5).
 *
 * Not a worker: it consumes no journal, advances no checkpoint and runs to completion. It is
 * the operator-facing half of the read model — the commands you run *around* the pipeline
 * rather than inside it.
 *
 *   engine index create    bootstrap an index with the real `tools` settings   (prod-safe)
 *   engine seed            fill a local index with the mock corpus             (dev only)
 *
 * The two have deliberately different blast radii, and each command owns its own guard rather
 * than sharing one: creating an index is how a fresh deployment starts, while seeding pushes
 * fabricated `install_methods` and must never reach a real corpus (§6).
 */
const log = workerLogger('engine');

const positiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
};

type Target = { host: string; index: string };
type SeedFlags = { batch: number; clear: boolean; force: boolean };

/**
 * `--host` and `--index` are added to each leaf command rather than declared once on the root,
 * because commander binds a root option before the subcommand name — `engine --index tools
 * index create` reads backwards. The default host comes from `config`, which has already
 * validated MEILI_HOST, so commander never re-reads the environment itself.
 */
const withTarget = (command: Command): Command =>
  command
    .option('-H, --host <url>', 'Meilisearch host', config.MEILI_HOST)
    .option('-i, --index <uid>', 'target index', TOOLS_ALIAS);

/** Every command talks to one Meilisearch; `--host` overrides MEILI_HOST for a one-off run. */
const clientFor = (host: string) => createAdminClient({ ...process.env, MEILI_HOST: host });

const program = new Command()
  .name('engine')
  .description('Keco read-model CLI — create and fill Meilisearch indexes')
  .showHelpAfterError();

const index = program.command('index').description('manage an index and its settings');

withTarget(index.command('create'))
  .description('create the index if missing and apply the tools settings — safe to run on production')
  .option(
    '--force-settings',
    'apply settings even to an index that already holds documents (this reindexes it)',
    false,
  )
  .action(async ({ host, index: uid, forceSettings }: Target & { forceSettings: boolean }) => {
    const plan = await createIndex(clientFor(host), uid, forceSettings);

    log.info({ index: uid, host, ...plan }, plan.applySettings ? 'index ready' : 'settings not applied');
    if (!plan.applySettings && !plan.create) {
      // Nothing was broken, but nothing was done either — say so loudly enough to be noticed
      // in a deploy log, and leave the exit code at 0 so a bootstrap step stays idempotent.
      log.warn({ index: uid }, plan.reason);
    }
  });

withTarget(program.command('seed'))
  .description('fill the index with the mock corpus — fabricated data, local Meilisearch only')
  .option('-b, --batch <n>', 'documents per batch', positiveInteger, 500)
  .option('--clear', 'delete every existing document first', false)
  .option('--force', 'allow a non-local MEILI_HOST', false)
  .action(async ({ host, index: uid, batch, clear, force }: Target & SeedFlags) => {
    assertSeedTarget(host, force);

    const documents = await loadCorpus();
    const client = clientFor(host);

    // Settings are what make a seeded index worth searching — facets, ranking, sorts. Refuse to
    // fill an unconfigured index rather than quietly producing a corpus with none of them.
    if (!(await readIndexState(client, uid)).exists) {
      throw new Error(`no index "${uid}" at ${host} — run \`engine index create\` first`);
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
      submit: (batch) => awaitTask(client.index(uid).addDocuments(batch)),
      onBatch: (batchNumber, documentsSent) =>
        log.debug({ batch: batchNumber, sent: documentsSent, of: documents.length }, 'batch indexed'),
    });

    const stats = await client.index(uid).getStats();
    log.info(
      { index: uid, sent, documentsInIndex: stats.numberOfDocuments },
      'mock corpus seeded — fabricated data, never a production index',
    );
  });

try {
  await program.parseAsync();
} catch (error) {
  log.error({ err: error instanceof Error ? error.message : String(error) }, 'engine failed');
  process.exit(1);
}
