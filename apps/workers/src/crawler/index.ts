import { GitHubClient } from '@keco/github';
import PQueue from 'p-queue';
import { ulid } from 'ulid';
import { config } from '../lib/config';
import type { DataStore } from '../lib/data-store';
import { type CrawlCounters } from './store/collections';
import { workerLogger } from '../lib/logger';
import { createProgress } from '../lib/progress';
import { createRuntime } from '../lib/runtime';
import { installShutdown } from '../lib/shutdown';
import { resolveSeeds } from './seeds';
import { fetchRepo, type RepoFetchResult } from './seeds/github/fetch';
import { CrawlHistoryStore } from './store/store';
import { buildWorklist, isOrgRef, type WorkItem } from './worklist';

/**
 * crawler — seeds + `discovery_repos` → `repos/**` + `RepoFetched` (AGENTS.md §4.2).
 *
 * Thin by construction, the way `runDiscovery` is: the per-repo pipeline is
 * `seeds/github/fetch.ts`, the sources are `seeds/*`, the merge is `worklist.ts`, the run record
 * is `store/store.ts`, the signal handling is `lib/shutdown.ts`. Anything carrying a decision
 * belongs in one of those, where a test can reach it without a network.
 *
 * It keeps no checkpoint. `CONSUMERS` is `['analyzer','projector']`, and §4's table lists the
 * crawler's inputs as seeds and a collection, not the journal. Its idempotence comes from ETags:
 * a re-run of an unchanged corpus is almost entirely 304s, which cost no quota at all.
 */
const log = workerLogger('crawler');

export type CrawlOptions = {
  seeds: string[];
  limit: number;
  /**
   * `owner/name` crawls one repo; a bare org (`worklist.ts`'s `isOrgRef`) crawls every repo
   * already discovered under it, from `discovery_repos` — not a fresh GitHub Search. `null`
   * means the full seeds-then-discovery-corpus run.
   */
  repo: string | null;
};

/**
 * The DataStore arrives as a dependency rather than being built here — the same contract
 * `runDiscovery` has. This file cannot name a backend, so it cannot couple to one;
 * `cli/data-store.ts` is the only place that chooses.
 */
export type CrawlerDeps = { dataStore: DataStore };

/** AGENTS.md §4: p-queue at ≈8, in-process. No Redis, no broker, no coordination primitive. */
const CONCURRENCY = 8;

// ── the pure-ish inner loop, exported so it can be tested without a network ──

export type CrawlDeps = {
  /**
   * Mutated in place, and deliberately the SAME object the run record reads. The shutdown
   * handler writes `interrupted` from another task, so counters that lived only in here would
   * make every killed run report zeros — the one record an operator opens after a crash.
   */
  counters: CrawlCounters;
  fetchRepo: (repo: string, source: string) => Promise<RepoFetchResult>;
  onFailure: (repo: string, error: Error) => Promise<void>;
  quotaExhausted: () => boolean;
  concurrency: number;
  onProgress: (snapshot: { items: number; done: number; known: number; requests: number }) => void;
  /**
   * Fired once per item, with whatever `fetchRepo` returned — fetched or skipped, never on a
   * throw (that's `onFailure`'s event, and it carries an `Error`, not a `RepoFetchResult`).
   * Optional: the batch path (seeds, `discovery_repos`) has no single result worth inspecting,
   * only `runCrawler`'s `--repo` path uses this, to tell "no such repo" from "found and queued"
   * rather than let an explicit, single-repo request end in a silent skip.
   */
  onItemResult?: (repo: string, result: RepoFetchResult) => void;
};

export async function crawl(items: readonly WorkItem[], deps: CrawlDeps): Promise<CrawlCounters> {
  const counters = deps.counters;
  const queue = new PQueue({ concurrency: deps.concurrency });
  let stopped = false;

  for (const item of items) {
    void queue.add(async () => {
      try {
        // Checked inside the task, not around the loop: by the time the eighth task starts, the
        // first seven have already reported their headers back to the governor.
        if (stopped) return;
        if (deps.quotaExhausted()) {
          // Finish the run rather than sleeping up to an hour inside a `mise run`. The next run
          // resumes for free — every repo already fetched now answers 304.
          stopped = true;
          counters.rate_limited += 1;
          return;
        }

        counters.repos_seen += 1;
        try {
          const result = await deps.fetchRepo(item.repo, item.source);
          deps.onItemResult?.(item.repo, result);
          counters.requests += result.requests;
          counters.points_spent += result.points;

          if (result.type === 'skipped') {
            counters.repos_skipped += 1;
          } else if (result.changed) {
            counters.repos_fetched += 1;
            if (result.icon_updated) counters.icons_updated += 1;
          } else {
            counters.repos_unchanged += 1;
          }
        } catch (error) {
          // A single bad repo must never abort a run (§13): catch per item, emit RepoFailed,
          // continue. The run's job is to make progress, not to be pure.
          //
          // Deliberately not `perItem()` from lib/runtime: this catch also has to bump a counter
          // on the shared record, and routing that through a helper whose whole signature is
          // (item, work, onError) would hide the one line that matters.
          counters.repos_failed += 1;
          await deps.onFailure(item.repo, error instanceof Error ? error : new Error(String(error)));
        }

        deps.onProgress({
          items: counters.repos_fetched,
          done: counters.repos_seen,
          known: items.length,
          requests: counters.requests,
        });
      } catch {
        // `onFailure` and `onProgress` are the only calls in this task not already guarded
        // above, and both are best-effort observability, not the work itself. A queued task is
        // fired with `void` and no `.catch()`, so anything escaping it becomes an unhandled
        // rejection that crashes the whole process — which would turn one repo's reporting
        // failure into the crawl's, defeating the isolation the inner try/catch exists to give.
        // Nothing more to do here: the repo is already counted as failed (or fetched) above;
        // this guard exists only to stop a SECOND failure from taking down the run.
      }
    });
  }

  await queue.onIdle();
  return counters;
}

// ── the wiring ──────────────────────────────────────────────────────────────

export async function runCrawler(
  { seeds, limit, repo }: CrawlOptions,
  { dataStore }: CrawlerDeps,
): Promise<void> {
  if (config.GITHUB_TOKEN === '') {
    log.error('GITHUB_TOKEN is required for the crawler — unauthenticated REST is 60 req/hour');
    process.exitCode = 1;
    return;
  }

  const { cache, journal } = createRuntime();
  const startedAt = new Date();

  const store = await CrawlHistoryStore.open(dataStore, {
    runId: ulid(startedAt.getTime()),
    startedAt,
    seeds,
    limit,
    repo,
    shardCount: config.SHARD_COUNT,
    shardIndex: config.SHARD_INDEX,
  });

  const progress = createProgress({ log });

  installShutdown({
    log,
    flush: async () => {
      // Per-repo work is already crash-safe, so there is no batch to lose — only the run record
      // has to say it was interrupted, or a killed crawl is indistinguishable from a live one.
      // `crawl()` mutates `store.counters` directly, so the numbers written here are live.
      await store.finishRun('interrupted');
    },
    done: () => progress.done(),
  });

  try {
    const client = new GitHubClient({
      token: config.GITHUB_TOKEN,
      consumer: 'crawler',
      quotaShare: config.GITHUB_QUOTA_CRAWLER_SHARE,
    });

    const items = await buildWorklist(
      {
        repo,
        seeds: resolveSeeds(repo === null ? seeds : []),
        limit,
        shardCount: config.SHARD_COUNT,
        shardIndex: config.SHARD_INDEX,
      },
      {
        dataStore,
        cache,
        fetch: globalThis.fetch,
        githubToken: config.GITHUB_TOKEN,
        onSeedError: (name, error) => store.recordSeedError(name, error),
      },
    );

    log.info(
      { seeds, limit, repo, items: items.length, shard: `${config.SHARD_INDEX}/${config.SHARD_COUNT}` },
      'crawler start',
    );

    // `--repo` names either one repo or an org; only the first has exactly one result worth
    // inspecting afterward. An org with nothing discovered under it is checked here, before
    // spending a single request — `items` is already empty, so there is nothing to crawl.
    if (repo !== null && isOrgRef(repo) && items.length === 0) {
      log.error({ repo }, `no repos discovered under org "${repo}" — run a discovery sweep first, or check the org name`);
      process.exitCode = 1;
    }

    // Only populated for a single-repo `--repo`: the batch path (and org mode) has many results,
    // none of them singularly interesting, but an operator who named one exact repo by hand
    // deserves to know whether it was ever found, not just a "1 skipped" buried in the summary
    // counters below. A ref object, not a plain `let` — TS's control-flow narrowing does not
    // track a `let` mutated only inside a callback, and narrows it back to its initial `null` at
    // every later read.
    const singleRepo = repo !== null && !isOrgRef(repo);
    const namedRepoResult: { current: RepoFetchResult | null } = { current: null };

    const counters = await crawl(items, {
      // The store's own object, so an interrupted run records real numbers (see CrawlDeps).
      counters: store.counters,
      concurrency: CONCURRENCY,
      quotaExhausted: () => client.quota.exhausted,
      fetchRepo: (target, source) =>
        fetchRepo(target, source, { cache, client, fetch: globalThis.fetch, journal }),
      onFailure: async (target, error) => {
        log.warn({ repo: target, err: error.message }, 'repo failed');
        await journal.append({ type: 'RepoFailed', repo: target, phase: 'crawl', error: error.message });
      },
      onProgress: (snapshot) => progress.update(snapshot),
      onItemResult: singleRepo ? (_target, result) => (namedRepoResult.current = result) : undefined,
    });

    progress.done();
    await store.finishRun('complete');

    log.info({ ...counters, quota: client.quota.describe() }, 'crawler complete');
    // Exit 0. A crawl of 30k repos where 12 are gone is a successful crawl; per-repo failures
    // are in the journal and counted on the run document. Unlike a discovery sweep, a missing
    // repo does not truncate a corpus.

    // The one exception: `--repo` names a specific repo, and "it doesn't exist" is the operator's
    // mistake (a typo, a renamed/deleted repo), not a corpus-wide fact to shrug off. The run
    // still recorded 'complete' above — nothing crashed, and RepoSkipped is already in the
    // journal — but the exit code has to say the one thing that was asked for wasn't there, or a
    // scripted `mise run repo:crawl -- --repo <typo>` reports success forever.
    if (
      singleRepo &&
      namedRepoResult.current?.type === 'skipped' &&
      namedRepoResult.current.reason === 'not-found'
    ) {
      log.error({ repo }, `repo not found: ${repo}`);
      process.exitCode = 1;
    }
  } catch (error) {
    progress.done();
    await store.finishRun('failed');
    throw error;
  }
}
