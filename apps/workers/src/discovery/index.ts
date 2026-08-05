import { parseArgs } from 'node:util';
import { SearchClient, type SearchItem } from '@keco/github';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createProgress, type Progress } from '../lib/progress';
import { createRuntime } from '../lib/runtime';
import { MAX_RESULTS_PER_QUERY, PER_PAGE, planWindow } from './plan';
import { DiscoveryStore, type RecordOutcome } from './store';
import { initialWindows, queryOf } from './windows';

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
 * `plan.ts`, all persistence is `store.ts`. What is left here is the loop, the CLI and the
 * shutdown story.
 */
const log = workerLogger('discovery');

const { values, positionals } = parseArgs({
  options: {
    query: { type: 'string', default: 'kubernetes' },
    limit: { type: 'string' },
    fresh: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

async function main(): Promise<void> {
  // `node:util`'s parseArgs treats everything after a bare `--` as positional, and pnpm
  // forwards that separator verbatim — so `pnpm -F @keco/workers discovery -- --limit 5`
  // parses to zero options and starts a full two-hour sweep with the flags silently dropped.
  // `mise run discovery -- --limit 5` is unaffected (mise appends the args, no separator), but
  // the other spelling is the one people reach for, so it fails loudly instead.
  if (positionals.length > 0) {
    throw new Error(
      `discovery takes no positional arguments, got ${JSON.stringify(positionals)}. ` +
        'If you invoked it as `pnpm -F @keco/workers discovery -- --flag`, drop the `--`; ' +
        'everything after it is treated as positional and the flags are ignored.',
    );
  }

  const query = values.query!;
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number, got "${values.limit}"`);
  }

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
    fresh: values.fresh,
    now,
    logger: log,
  });
  const search = SearchClient.fromToken(config.GITHUB_TOKEN, { logger: log });
  const progress = createProgress({ log });

  // A non-empty queue means the last sweep was interrupted, so continue it. An empty one means
  // the last sweep finished (or there was none): start a new sweep over every window. Only the
  // window bookkeeping and the per-sweep counters reset — the repo list and the hashes carry
  // over, which is what makes a second sweep re-check the corpus while still skipping unchanged
  // documents.
  const resuming = store.state.pending_windows.length > 0;
  if (!resuming) {
    store.state.pending_windows = initialWindows(query);
    store.state.completed_windows = [];
    store.state.failed_windows = [];
    store.state.started_at = now.toISOString();
    store.state.requests = 0;
  }

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
      fresh: values.fresh,
      resuming,
      known_repos: store.size,
      windows: queue.length,
    },
    'discovery start',
  );

  installShutdown(store, progress);

  let stopped = false;
  // Items GitHub returned that failed per-item validation. Nothing is dropped silently (§13):
  // `SearchClient` warns per page, and this is the run-level total for the summary line.
  let droppedItems = 0;
  // Per-run write outcomes. The design's definition of done is "re-running writes zero detail
  // files and reports every repo as unchanged" — without these counters that is only checkable
  // by stat-ing the cache, so the summary carries it instead.
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
          store.state.requests += 1;
          const probe = await search.page(q, 1, PER_PAGE);
          droppedItems += probe.dropped;
          await recordAll(store, probe.items, q, outcomes);

          const plan = planWindow(window, probe.total_count, now);
          if (plan.truncated) {
            log.warn(
              { window: q, total_count: probe.total_count, kept: MAX_RESULTS_PER_QUERY },
              'window exceeds 1000 at day granularity — truncated',
            );
          }

          for (let page = 2; page <= plan.lastPage; page += 1) {
            store.state.requests += 1;
            const next = await search.page(q, page, PER_PAGE);
            droppedItems += next.dropped;
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
        requests: store.state.requests,
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

  log.info(
    {
      repos: store.size,
      windows_completed: completed.size,
      windows_failed: store.state.failed_windows.length,
      windows_pending: queue.length,
      requests: store.state.requests,
      repos_new: outcomes.new,
      repos_changed: outcomes.changed,
      repos_unchanged: outcomes.unchanged,
      dropped_items: droppedItems,
      stopped_at_limit: stopped,
    },
    'discovery complete',
  );
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

/**
 * A cold sweep runs one to two hours, so Ctrl-C is normal operation, not an incident — and the
 * `finally` above cannot help, because a signal tears the process down without unwinding.
 *
 * Flushing straight from the handler, rather than asking the loop to stop and unwind, is safe
 * and it is what keeps the interruption cheap: `pending_windows` still lists the in-flight
 * window (the loop peeks), so a resume simply refetches it, and every repo already recorded
 * from it is skipped by its unchanged hash. Racing an in-flight `record()` is harmless in both
 * directions — the detail file write is atomic, and a repo that lands in `hashes` a moment
 * after the list was serialised just looks new again next run and is rewritten.
 *
 * A second signal means the operator wants out now, flush or no flush.
 */
function installShutdown(store: DiscoveryStore, progress: Progress): void {
  let shuttingDown = false;

  const handle = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const code = signal === 'SIGINT' ? 130 : 143;
    if (shuttingDown) process.exit(code);
    shuttingDown = true;
    log.warn({ signal }, 'discovery interrupted — flushing artifacts, signal again to abort');

    void (async () => {
      try {
        await store.flush();
      } catch (error) {
        log.error(
          { signal, error: error instanceof Error ? error.message : String(error) },
          'flush on shutdown failed',
        );
      }
      progress.done();
      process.exit(code);
    })();
  };

  process.on('SIGINT', () => handle('SIGINT'));
  process.on('SIGTERM', () => handle('SIGTERM'));
}

try {
  await main();
} catch (error) {
  log.error({ error: error instanceof Error ? error.message : String(error) }, 'discovery failed');
  process.exitCode = 1;
}
