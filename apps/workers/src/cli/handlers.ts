import { createInterface } from 'node:readline';
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

/**
 * A provisioned store. The explore commands read collections a sweep may never have created —
 * `discovery count` on a fresh machine is the obvious case — and every implementation refuses
 * an unknown collection by design (§ "an unknown collection must throw from every operation").
 * `DiscoveryStore.open()` ensures for the sweep path; these three have no sweep in front of
 * them, so they must ensure for themselves.
 *
 * Missing this was invisible against Meilisearch, where a previous sweep had already created
 * the indexes, and only surfaced under DISCOVERY_STORE=fs against an empty cache.
 */
async function exploreStore() {
  const { createDataStore } = await import('./data-store');
  const { DISCOVERY_COLLECTIONS } = await import('../discovery/store/collections');
  const dataStore = createDataStore();
  await dataStore.ensure(DISCOVERY_COLLECTIONS);
  return dataStore;
}

export const handlers: Handlers = {
  discoverySweep: async (options) => {
    const { createDataStore } = await import('./data-store');
    return (await import('../discovery')).runDiscovery(options, { dataStore: createDataStore() });
  },

  discoveryCount: async ({ query, json }) => {
    const { countDiscovery } = await import('../discovery/explore');
    const { formatCount, ndjson } = await import('../discovery/explore-format');

    const rows = await countDiscovery(await exploreStore(), { query });
    // stdout, not the logger: this is a result, not a log line (§8 of the spec).
    process.stdout.write(`${json ? ndjson(rows) : formatCount(rows)}\n`);
  },

  discoveryList: async ({ target, query, limit, sort, json }) => {
    const { listRepos, listRuns } = await import('../discovery/explore');
    const { formatRepos, formatRuns, ndjson } = await import('../discovery/explore-format');

    const dataStore = await exploreStore();
    const options = { query, limit, sort };
    const result =
      target === 'runs' ? await listRuns(dataStore, options) : await listRepos(dataStore, options);

    const rendered = json
      ? ndjson(result.rows)
      : target === 'runs'
        ? formatRuns(result)
        : formatRepos(result);
    process.stdout.write(`${rendered}\n`);
  },

  discoveryReset: async ({ query, all, includeRuns, yes }) => {
    const { applyReset, planReset } = await import('../discovery/explore');

    const dataStore = await exploreStore();
    const plans = await planReset(dataStore, { query, all, includeRuns });

    if (plans.length === 0) {
      log.info({ query, all }, 'nothing to reset');
      return;
    }

    // The plan prints before the prompt, with real counts: an operator confirms against what
    // is actually there, not against what they assumed was there.
    for (const plan of plans) {
      process.stdout.write(
        `  ${plan.query_slug}\n` +
          `    discovery_repos  ${plan.repos.toLocaleString('en-US').padStart(8)}  → delete\n` +
          `    discovery_state  ${String(plan.state).padStart(8)}  → delete\n` +
          `    discovery_runs   ${plan.runs.toLocaleString('en-US').padStart(8)}  → ` +
          `${plan.delete_runs ? 'delete' : 'keep (--include-runs to delete)'}\n`,
      );
    }
    process.stdout.write(
      '\nthis is not rebuildable offline; the next sweep re-queries GitHub Search\n',
    );

    if (!yes && !(await confirm())) {
      log.warn({ query, all }, 'reset cancelled');
      return;
    }

    await applyReset(dataStore, plans);
    log.info(
      { queries: plans.map((plan) => plan.query_slug), include_runs: includeRuns },
      'discovery reset',
    );
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

    // The discovery collections are provisioned here too, so a fresh deployment bootstraps
    // both usages of the instance — the searchable read model and the write-side data store.
    // ensure() compares settings before applying them, so this is safe to re-run.
    const { createDataStore } = await import('./data-store');
    const { DISCOVERY_COLLECTIONS } = await import('../discovery/store/collections');
    await createDataStore({ ...process.env, MEILI_HOST: host }).ensure(DISCOVERY_COLLECTIONS);
    log.info(
      { collections: DISCOVERY_COLLECTIONS.map((c) => c.name) },
      'discovery collections ready',
    );
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

/**
 * Defaults to no on anything that is not an explicit `y`, including EOF — a reset piped from
 * a script with no `--yes` must decline rather than proceed on an empty stdin.
 *
 * `node:readline/promises`' `question()` looks like the obvious fit here, but its promise
 * never settles when the input stream ends before an answer arrives (piped-from-`/dev/null`,
 * a script with no `--yes`) — the process only exits because Node force-terminates on an
 * unsettled top-level await, not because this function resolved. The callback-based
 * `node:readline` interface has the same gap, so the fix is the same either way: race the
 * answer against the interface's own `close` event, which fires on EOF, and treat that as "no".
 */
function confirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.question('continue? [y/N] ', (answer) => finish(answer.trim().toLowerCase() === 'y'));
    rl.once('close', () => finish(false));
  });
}
