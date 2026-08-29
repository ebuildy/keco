import { SearchClient, type SearchItem } from '@keco/github';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createProgress } from '../lib/progress';
import { createRuntime } from '../lib/runtime';
import { installShutdown } from '../lib/shutdown';
import { MAX_RESULTS_PER_QUERY, PER_PAGE, planWindow } from './plan';
import { DiscoveryStore, type RecordOutcome } from './store';
import { beginSweep } from './sweep';
import { queryOf } from './windows';

/**
 * discovery — GitHub Search → `discovery/**` YAML (design 2026-08-02).
 *
 * Sits before the crawler and is the only component that calls GitHub Search. It enumerates
 * every repo matching a keyword by subdividing the corpus into windows that each fit under
 * Search's 1000-result cap, and writes a full list plus one detail document per repo.
 *
 * Deliberately *not* a journal consumer, and it emits no events — see the design's "No journal
 * events" note. It writes only under `discovery/`, only through the Storage port.
 *
 * Thin by construction: the window algebra is `windows.ts`, the split/paginate decision is
 * `plan.ts`, the resume-vs-new-sweep decision is `sweep.ts`, the signal handling is
 * `lib/shutdown.ts`, all persistence is `store.ts`. Argument parsing is `cli/program.ts`, and
 * this module executes nothing on import — it exports `runDiscovery`, which `kecoctl
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

export async function runDiscovery({ query, limit, fresh }: DiscoveryOptions): Promise<void> {
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

  const { cache } = createRuntime();
  const store = await DiscoveryStore.open(cache, query, {
    fresh,
    now,
    logger: log,
  });
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
    flush: () => store.flush(),
    done: () => progress.done(),
  });

  let stopped = false;
  // Per-*process* write outcomes, as opposed to the per-*sweep* counters on `store.state`,
  // which accumulate across every resume. The summary below names the two scopes apart
  // (`run_` vs `sweep_`): reporting "76 pages, 0 dropped" when the 76 covers two runs and the
  // 0 covers one is worse than reporting neither.
  //
  // These exist because the design's definition of done is "re-running writes zero detail files
  // and reports every repo as unchanged", which is otherwise only checkable by stat-ing the
  // cache.
  const outcomes: Record<RecordOutcome, number> = { new: 0, changed: 0, unchanged: 0 };

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
          await recordAll(store, probe.items, q, outcomes);

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
            await recordAll(store, next.items, q, outcomes);
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
        repos: store.size,
        windowsDone: completed.size,
        windowsKnown: completed.size + queue.length,
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
    // `sweep_` fields accumulate across every resume of this sweep; `run_` fields cover only
    // this process. They are not comparable, so they are not named alike.
    sweep_repos: store.size,
    sweep_windows_completed: completed.size,
    sweep_windows_failed: failed,
    sweep_windows_pending: queue.length,
    sweep_pages_fetched: store.state.pages_fetched,
    sweep_dropped_items: store.state.dropped,
    run_docs_written_new: outcomes.new,
    run_docs_written_changed: outcomes.changed,
    // Sightings, not repos: `record()` answers 'unchanged' both for "the payload hash matched"
    // and for "already seen earlier in this run", and a cold sweep reports plenty of the
    // second. Counting distinct repos here would mean a second set the size of the corpus.
    run_sightings_skipped: outcomes.unchanged,
    stopped_at_limit: stopped,
  };

  if (failed > 0) {
    // A failed window is a silently truncated corpus: it is dropped from the queue, is not
    // retried in-run, and does not come back on resume — it only returns on the next full
    // sweep. `SearchClient` already retries throttles and transient statuses, so what reaches
    // this point is the non-retryable class. Exiting 0 here would let a scheduled sweep hand
    // the crawler a corpus missing an entire star band and call it a success.
    process.exitCode = 1;
    log.error(
      { ...summary, failed_windows: store.state.failed_windows },
      'discovery finished with failed windows — the corpus is incomplete',
    );
    return;
  }

  log.info(summary, 'discovery complete');
}

async function recordAll(
  store: DiscoveryStore,
  items: readonly SearchItem[],
  via: string,
  outcomes: Record<RecordOutcome, number>,
): Promise<void> {
  for (const item of items) {
    try {
      outcomes[await store.record(item, via)] += 1;
    } catch (error) {
      log.warn(
        { repo: item.full_name, error: error instanceof Error ? error.message : String(error) },
        'could not record repo',
      );
    }
  }
}
