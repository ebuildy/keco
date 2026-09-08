import { SearchClient, type SearchItem } from '@keco/github';
import { config } from '../lib/config';
import type { DataStore } from '../lib/data-store';
import { workerLogger } from '../lib/logger';
import { createProgress } from '../lib/progress';
import { installShutdown } from '../lib/shutdown';
import { MAX_RESULTS_PER_QUERY, PER_PAGE, planWindow } from './plan';
import { DiscoveryStore } from './store/store';
import { beginSweep } from './sweep';
import { queryOf } from './windows';

/**
 * discovery — GitHub Search → `discovery/**` (design 2026-08-02, storage moved behind
 * `DataStore` — docs/adr/0002-discovery-datastore.md).
 *
 * Sits before the crawler and is the only component that calls GitHub Search. It enumerates
 * every repo matching a keyword by subdividing the corpus into windows that each fit under
 * Search's 1000-result cap, and records a repo document plus per-sweep state for each window.
 *
 * Deliberately *not* a journal consumer, and it emits no events — see the design's "No journal
 * events" note. It writes only through the `DataStore` port `DiscoveryStore` wraps.
 *
 * Thin by construction: the window algebra is `windows.ts`, the split/paginate decision is
 * `plan.ts`, the resume-vs-new-sweep decision is `sweep.ts`, the signal handling is
 * `lib/shutdown.ts`, all persistence is `store/store.ts`. Argument parsing is `cli/program.ts`,
 * and this module executes nothing on import — it exports `runDiscovery`, which `kecoctl
 * discovery sweep` calls. Anything that carries a decision belongs in one of those modules,
 * and every one of them exists because a bug was found in it.
 */
const log = workerLogger('discovery');

export type DiscoveryOptions = {
  query: string;
  /** `null` means no limit. Validated as a positive integer by the CLI. */
  limit: number | null;
  fresh: boolean;
};

/**
 * The DataStore arrives as a dependency rather than being built here. That is the whole
 * point of the port: this file cannot name a backend, so it cannot accidentally couple to
 * one. `apps/workers/src/cli/handlers.ts` is the only place that chooses.
 */
export type DiscoveryDeps = { dataStore: DataStore };

export async function runDiscovery(
  { query, limit, fresh }: DiscoveryOptions,
  { dataStore }: DiscoveryDeps,
): Promise<void> {
  // Unauthenticated search is 10 req/min, which turns a two-hour sweep into a six-hour one.
  if (config.GITHUB_TOKEN === '') {
    log.error('GITHUB_TOKEN is required for discovery — unauthenticated search is 10 req/min');
    process.exitCode = 1;
    return;
  }

  // One clock read for the whole sweep. `split()` requires it (and refuses to default it):
  // sampling the wall clock per call would let a run that straddles midnight — or New Year —
  // disagree with itself about how many yearly windows an unconstrained band expands to, and
  // window identity is a query string, so that disagreement silently breaks resume.
  const now = new Date();

  const store = await DiscoveryStore.open(dataStore, query, { fresh, now, limit, logger: log });
  const search = SearchClient.fromToken(config.GITHUB_TOKEN, { logger: log });
  const progress = createProgress({ log });

  const resuming = beginSweep(store.state, query, now);

  // The queue *is* `state.pending_windows`, aliased on purpose. Two properties make that safe:
  // `Cache.putJSON` stringifies synchronously, so a flush can never observe a half-mutated
  // array; and the loop peeks rather than shifts (see below), so the array always describes
  // exactly the work still owed, at every await point.
  const queue = store.state.pending_windows;
  const completed = new Set(store.state.completed_windows);

  log.info(
    {
      query,
      limit,
      fresh,
      resuming,
      known_repos: store.size,
      windows: queue.length,
    },
    'discovery start',
  );

  installShutdown({
    log,
    flush: async () => {
      await store.flush();
      // The history has to say the sweep was interrupted, or a killed run is
      // indistinguishable from one that is still going.
      await store.finishRun('interrupted');
    },
    done: () => progress.done(),
  });

  let stopped = false;

  try {
    while (queue.length > 0 && !stopped) {
      // Peek, do not shift. `queue` is the persisted `pending_windows`, and a flush can happen
      // at any await below (the shutdown handler), so the window being worked on has to stay
      // in the array until it is recorded complete or failed. Shifting first would let a
      // Ctrl-C mid-window persist a state that lists it as neither pending nor completed —
      // silently dropping it from the sweep.
      const window = queue[0]!;
      const q = queryOf(window);

      // Already done in an earlier, interrupted run. Cheap insurance against a window being
      // enqueued twice by subdivision.
      if (!completed.has(q)) {
        try {
          store.state.pages_fetched += 1;
          const probe = await search.page(q, 1, PER_PAGE);
          store.state.dropped += probe.dropped;
          await recordAll(store, probe.items, q);

          const plan = planWindow(window, probe.total_count, now);
          if (plan.truncated) {
            log.warn(
              { window: q, total_count: probe.total_count, kept: MAX_RESULTS_PER_QUERY },
              'window exceeds 1000 at day granularity — truncated',
            );
          }

          for (let page = 2; page <= plan.lastPage; page += 1) {
            store.state.pages_fetched += 1;
            const next = await search.page(q, page, PER_PAGE);
            store.state.dropped += next.dropped;
            await recordAll(store, next.items, q);
          }

          if (plan.children.length > 0) {
            queue.push(...plan.children);
            log.debug(
              { window: q, total_count: probe.total_count, parts: plan.children.length },
              'split',
            );
          }

          completed.add(q);
          store.state.completed_windows.push(q);
        } catch (error) {
          // One bad window never aborts a sweep (§13).
          const message = error instanceof Error ? error.message : String(error);
          store.state.failed_windows.push({ window: q, error: message });
          log.error({ window: q, error: message }, 'window failed');
        }
      }

      queue.shift();
      // Interval-based: the store decides whether this actually writes. Serialising the whole
      // corpus after every window costs ~950ms at 100k repos, against windows that can be a
      // single paced request.
      await store.windowCompleted();

      // Outside the `completed` guard on purpose: on a resume that skips a run of already-done
      // windows the bar would otherwise sit frozen while real work (queue drain) happens.
      progress.update({
        items: store.size,
        done: completed.size,
        known: completed.size + queue.length,
        requests: store.state.pages_fetched,
      });

      if (limit !== null && store.size >= limit) stopped = true;
    }
  } finally {
    // "Safe to kill at any moment" (§4) cuts both ways: an unexpected throw must not discard
    // up to 30s of paced requests, and must not leave `pending_windows` describing a queue
    // that has since drained.
    await store.flush();
    progress.done();
  }

  const failed = store.state.failed_windows.length;
  const summary = {
    // `sweep_` fields accumulate across every resume; `run_` fields cover only this process.
    // They are not comparable, so they are not named alike.
    run_id: store.runId,
    sweep_repos: store.size,
    sweep_windows_completed: completed.size,
    sweep_windows_failed: failed,
    sweep_windows_pending: queue.length,
    sweep_pages_fetched: store.state.pages_fetched,
    sweep_dropped_items: store.state.dropped,
    stopped_at_limit: stopped,
  };

  if (failed > 0) {
    // A failed window is a silently truncated corpus: it is dropped from the queue, is not
    // retried in-run, and only returns on the next full sweep. Exiting 0 would let a
    // scheduled sweep hand the crawler an incomplete corpus and call it a success.
    await store.finishRun('failed', new Date(), { stoppedAtLimit: stopped });
    process.exitCode = 1;
    log.error(
      { ...summary, failed_windows: store.state.failed_windows },
      'discovery finished with failed windows — the corpus is incomplete',
    );
    return;
  }

  await store.finishRun('complete', new Date(), { stoppedAtLimit: stopped });
  log.info(summary, 'discovery complete');
}

async function recordAll(
  store: DiscoveryStore,
  items: readonly SearchItem[],
  via: string,
): Promise<void> {
  for (const item of items) {
    try {
      await store.record(item, via);
    } catch (error) {
      log.warn(
        { repo: item.full_name, error: error instanceof Error ? error.message : String(error) },
        'could not record repo',
      );
    }
  }
}
