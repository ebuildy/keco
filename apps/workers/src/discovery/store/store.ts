import type { SearchItem } from '@keco/github';
import { ulid } from 'ulid';
import type { DataStore, Document } from '../../lib/data-store';
import {
  DISCOVERY_COLLECTIONS,
  REPOS,
  RUNS,
  STATE,
  slugifyQuery,
  toDetail,
  toRepoDocument,
  toRunDocument,
  toStateDocument,
  type DiscoveryState,
  type RunOutcome,
} from './collections';
import { KnownRepoSchema, StateDocumentSchema } from './schemas';

/**
 * Everything discovery reads and writes, over the `DataStore` port — no filesystem, no
 * backend, no key building. `collections.ts` owns the document shapes; this file owns the
 * bookkeeping: what counts as changed, which sighting wins, and when a flush is due.
 *
 * Two crash-safety properties it leans on, both provided by the port:
 *  - `put` deep-copies synchronously, so a live array being mutated by `runDiscovery` cannot
 *    be persisted half-written.
 *  - `put({durable: true})` resolves only when it *and every earlier put* is durable, which
 *    is what makes the corpus-then-state ordering below meaningful.
 *
 * Everything read back is still validated (AGENTS.md §13): atomicity says nothing about a
 * document written by an older version of this code or hand-edited in the fs store. `open()`
 * degrades — warns and starts a fresh sweep, or drops the bad rows — rather than throwing,
 * because a worker that needs a manual delete to restart is worse than a resweep.
 */

export type RecordOutcome = 'new' | 'changed' | 'unchanged';

export type DiscoveryLogger = { warn(fields: object, message: string): void };
const noopLogger: DiscoveryLogger = { warn: () => {} };

/**
 * What the resume path needs per repo. One map keyed by GitHub's numeric id, where the old
 * filesystem store kept two — `entries` by id and `hashes` by `full_name` — and documented
 * the desync after a repo rename as an accepted limitation. There is no second key to drift.
 */
type KnownRepo = { payload_hash: string; first_seen_run_id: string };

export type OpenOptions = {
  fresh?: boolean;
  now?: Date;
  logger?: DiscoveryLogger;
  /** Injected so tests are deterministic; defaults to a fresh ULID. */
  runId?: string;
  /** Recorded on the run document so history explains a short sweep. */
  limit?: number | null;
};

export class DiscoveryStore {
  /** Repos already recorded in this process — what makes first-wins hold *within* a run. */
  private readonly seenThisRun = new Set<number>();

  /** Documents recorded but not yet written. Drained by `flush`. */
  private pendingRepos: Document[] = [];

  /** Flush cadence: 25 windows or 30s, whichever comes first. See `windowCompleted`. */
  private static readonly FLUSH_WINDOW_COUNT = 25;
  private static readonly FLUSH_INTERVAL_MS = 30_000;
  /** Upsert batch size — AGENTS.md §4's "batches of ≤1000". */
  private static readonly WRITE_BATCH = 1000;

  private windowsSinceFlush = 0;
  private lastFlushAt: number;

  /** Write outcomes for THIS process, as opposed to the sweep counters on `state`. */
  private readonly runCounts = { new: 0, changed: 0, unchanged: 0 };

  /**
   * Sweep-scoped counters as they stood when this process opened. Subtracting gives the
   * run-scoped numbers the history reports — `state.pages_fetched` accumulates across every
   * resume, and reporting a two-run total as one run's cost is worse than reporting nothing.
   */
  private readonly openedWith: {
    pagesFetched: number;
    dropped: number;
    windowsCompleted: number;
    windowsFailed: number;
  };

  /**
   * Serialises overlapping `flush()` calls — the shutdown handler's and the loop's can be in
   * flight at once. Without it the two interleave *within* one flush, and if the earlier
   * flush's corpus write lands last you get a state marking a window complete alongside a
   * corpus missing its repos. Nothing would ever refetch them. The `.catch` is what stops one
   * failed flush poisoning every later one.
   */
  private flushing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dataStore: DataStore,
    private readonly query: string,
    readonly querySlug: string,
    private readonly known: Map<number, KnownRepo>,
    readonly state: DiscoveryState,
    readonly runId: string,
    private readonly startedAt: Date,
    private readonly fresh: boolean,
    private readonly limit: number | null,
  ) {
    this.lastFlushAt = startedAt.getTime();
    this.openedWith = {
      pagesFetched: state.pages_fetched,
      dropped: state.dropped,
      windowsCompleted: state.completed_windows.length,
      windowsFailed: state.failed_windows.length,
    };
  }

  static async open(
    dataStore: DataStore,
    query: string,
    options: OpenOptions = {},
  ): Promise<DiscoveryStore> {
    const now = options.now ?? new Date();
    const logger = options.logger ?? noopLogger;
    // Throws for a query with no usable slug — before any I/O, so a hostile `--query` never
    // reaches the backend.
    const querySlug = slugifyQuery(query);
    const runId = options.runId ?? ulid();

    await dataStore.ensure(DISCOVERY_COLLECTIONS);

    if (options.fresh === true) {
      // `--fresh` deletes rather than merely ignoring. The filesystem store left orphaned
      // detail files behind and documented it as an accepted limitation; here the corpus is
      // one filterable collection, so a fresh sweep can genuinely start clean.
      await dataStore.remove(REPOS, { query_slug: querySlug });
      await dataStore.remove(STATE, { query_slug: querySlug });
    }

    const stored = options.fresh === true ? null : await loadState(dataStore, querySlug, logger);
    const known = new Map<number, KnownRepo>();

    if (stored !== null) {
      // Only load the corpus once there is validated state to resume: the corpus carries no
      // progress bookkeeping of its own, so state is what says how far the sweep got.
      // Unreadable state means a full resweep, not a best-effort partial load.
      let dropped = 0;
      for await (const row of dataStore.list(REPOS, {
        where: { query_slug: querySlug },
        fields: ['repo_id', 'payload_hash', 'first_seen_run_id'],
      })) {
        const parsed = KnownRepoSchema.safeParse(row);
        if (!parsed.success) {
          dropped += 1;
          continue;
        }
        known.set(parsed.data.repo_id, {
          payload_hash: parsed.data.payload_hash,
          first_seen_run_id: parsed.data.first_seen_run_id,
        });
      }
      if (dropped > 0) {
        logger.warn(
          { dropped, kept: known.size, collection: REPOS, query_slug: querySlug },
          'discovery: dropped malformed rows while loading the corpus',
        );
      }
    }

    const state: DiscoveryState = stored ?? {
      query,
      started_at: now.toISOString(),
      pending_windows: [],
      completed_windows: [],
      failed_windows: [],
      repos_seen: 0,
      pages_fetched: 0,
      dropped: 0,
    };

    const store = new DiscoveryStore(
      dataStore,
      query,
      querySlug,
      known,
      state,
      runId,
      now,
      options.fresh === true,
      options.limit ?? null,
    );

    // Written immediately, not at the end: a sweep that is killed still leaves evidence it
    // started, and `outcome: 'running'` in the history is exactly how an operator spots one
    // that never finished.
    await store.writeRun('running');
    return store;
  }

  get size(): number {
    return this.known.size;
  }

  /**
   * Records one search hit, buffering its document only when the payload changed. The first
   * window to find a repo owns its `discovered_via`; later sightings are dropped.
   *
   * First-wins also means a document can be up to one sweep stale: if a repo changes between
   * its owning window recording it and a later window that would otherwise re-see it, the
   * fresher data is discarded for this sweep. Accepted — picking the "best" sighting needs a
   * definition of best this design does not have, and it self-heals on the next sweep.
   */
  async record(item: SearchItem, via: string, now = new Date()): Promise<RecordOutcome> {
    if (this.seenThisRun.has(item.id)) {
      this.runCounts.unchanged += 1;
      return 'unchanged';
    }

    const detail = toDetail(item, via, now.toISOString());
    const known = this.known.get(detail.repo_id);
    if (known !== undefined && known.payload_hash === detail.payload_hash) {
      this.seenThisRun.add(detail.repo_id);
      this.runCounts.unchanged += 1;
      return 'unchanged';
    }

    const firstSeenRunId =
      known?.first_seen_run_id === undefined || known.first_seen_run_id === ''
        ? this.runId
        : known.first_seen_run_id;

    this.pendingRepos.push(
      toRepoDocument(detail, {
        query: this.query,
        querySlug: this.querySlug,
        runId: this.runId,
        firstSeenRunId,
      }),
    );
    this.known.set(detail.repo_id, {
      payload_hash: detail.payload_hash,
      first_seen_run_id: firstSeenRunId,
    });
    this.seenThisRun.add(detail.repo_id);
    const outcome = known === undefined ? 'new' : 'changed';
    this.runCounts[outcome] += 1;
    return outcome;
  }

  /**
   * Call once a window's results have all been recorded — windows, not records, are the unit
   * the flush policy counts in, because a window is also the retry granularity: on resume an
   * incomplete window is refetched whole, so there is no finer notion of progress.
   *
   * The orchestrator owns *calling* this; it does not own *deciding* whether the call writes.
   * `flush()` stays available and is the unconditional path the orchestrator must use at
   * sweep end and around a caught error — "safe to kill at any moment" (§4) means the data
   * has to be durable before the process is allowed to exit, on every path out.
   *
   * Returns whether a flush actually ran, so a test can assert on it without reaching into
   * private counters.
   */
  async windowCompleted(now = new Date()): Promise<boolean> {
    this.windowsSinceFlush += 1;
    const due =
      this.windowsSinceFlush >= DiscoveryStore.FLUSH_WINDOW_COUNT ||
      now.getTime() - this.lastFlushAt >= DiscoveryStore.FLUSH_INTERVAL_MS;
    if (!due) return false;
    await this.flush(now);
    return true;
  }

  async flush(now = new Date()): Promise<void> {
    const turn = this.flushing.then(() => this.writeAll(now));
    this.flushing = turn.catch(() => undefined);
    return turn;
  }

  /**
   * Corpus first, then state — and state alone is `durable`. The order is load-bearing:
   * `state.completed_windows` is the resume decision, so it must never become durable ahead
   * of the repos it claims are recorded. `durable` means "this write and every earlier one",
   * so by the time the state put resolves the corpus batches are confirmed too. Reversing the
   * order would let state advance past repos that were never written: silently missing from
   * the corpus, with nothing to signal it.
   */
  private async writeAll(now: Date): Promise<void> {
    // Snapshot at the instant of the write, never cached from an earlier record().
    this.state.repos_seen = this.known.size;

    const batch = this.pendingRepos;
    this.pendingRepos = [];
    try {
      for (let i = 0; i < batch.length; i += DiscoveryStore.WRITE_BATCH) {
        await this.dataStore.put(REPOS, batch.slice(i, i + DiscoveryStore.WRITE_BATCH));
      }
    } catch (error) {
      // Put them back: a failed flush must not silently drop a window's repos, and the next
      // flush (or the one in `runDiscovery`'s finally) is the retry.
      this.pendingRepos = [...batch, ...this.pendingRepos];
      throw error;
    }

    await this.dataStore.put(
      STATE,
      [toStateDocument(this.state, { querySlug: this.querySlug, runId: this.runId, now })],
      { durable: true },
    );

    this.windowsSinceFlush = 0;
    this.lastFlushAt = now.getTime();
  }

  /**
   * Stamps the run's ending. Called on every path out of `runDiscovery` — normal completion,
   * a failed-window exit, and the shutdown handler.
   *
   * A `SIGKILL` never reaches here, so that run stays `running` in the history forever. That
   * is deliberate: the stuck row is the signal a sweep died without cleanup, and a later run
   * quietly repairing it would hide exactly the failure someone is looking for.
   */
  async finishRun(
    outcome: Exclude<RunOutcome, 'running'>,
    now = new Date(),
    extra: { stoppedAtLimit?: boolean } = {},
  ): Promise<void> {
    await this.writeRun(outcome, now, extra);
  }

  private async writeRun(
    outcome: RunOutcome,
    now?: Date,
    extra: { stoppedAtLimit?: boolean } = {},
  ): Promise<void> {
    await this.dataStore.put(
      RUNS,
      [
        toRunDocument({
          runId: this.runId,
          query: this.query,
          querySlug: this.querySlug,
          startedAt: this.startedAt,
          fresh: this.fresh,
          limit: this.limit,
          outcome,
          ...(outcome === 'running' ? {} : { endedAt: now ?? new Date() }),
          counts: { ...this.runCounts },
          pagesFetched: this.state.pages_fetched - this.openedWith.pagesFetched,
          dropped: this.state.dropped - this.openedWith.dropped,
          windowsCompleted: this.state.completed_windows.length - this.openedWith.windowsCompleted,
          windowsFailed: this.state.failed_windows.length - this.openedWith.windowsFailed,
          sweepReposTotal: this.known.size,
          sweepWindowsPending: this.state.pending_windows.length,
          stoppedAtLimit: extra.stoppedAtLimit ?? false,
          failedWindows: this.state.failed_windows,
        }),
      ],
      // Durable: the history is the one collection nothing can reconstruct, and a run record
      // lost to a crash is a sweep that never happened as far as anyone can tell.
      { durable: true },
    );
  }
}

/**
 * Reads the state document, validated. Returns `null` — never throws — for anything that is
 * not clean, schema-valid state. The caller treats `null` as "start a fresh sweep", which is
 * always safe: GitHub Search is the source of truth and this document is only ever a resume
 * optimisation.
 */
async function loadState(
  dataStore: DataStore,
  querySlug: string,
  logger: DiscoveryLogger,
): Promise<DiscoveryState | null> {
  const raw = await dataStore.get(STATE, querySlug);
  if (raw === null) return null;

  const result = StateDocumentSchema.safeParse(raw);
  if (!result.success) {
    logger.warn(
      { collection: STATE, query_slug: querySlug, issues: result.error.issues.slice(0, 5) },
      'discovery: state document failed validation — starting a fresh sweep instead of wedging',
    );
    return null;
  }

  const {
    query,
    started_at,
    pending_windows,
    completed_windows,
    failed_windows,
    repos_seen,
    pages_fetched,
    dropped,
  } = result.data;
  return {
    query,
    started_at,
    pending_windows,
    completed_windows,
    failed_windows,
    repos_seen,
    pages_fetched,
    dropped,
  };
}
