import { createHash } from 'node:crypto';
import { type Cache, discoveryKeys } from '@keco/cache';
import type { SearchItem } from '@keco/github';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { Created, Window } from './windows';

/**
 * Everything discovery reads and writes (design 2026-08-02, hardened 2026-08-05 after
 * review). All of it through the Storage port — no fs, no path building (AGENTS.md §14).
 *
 * The full list and the hash index are held in memory for the length of a run, which is what
 * makes change detection a map lookup instead of re-reading 100k YAML files per sweep. At
 * ~100k repos that's roughly 55 MB of heap — measured, not the on-disk size — and it buys
 * hours.
 *
 * Two crash-safety properties this file leans on, and where each is enforced:
 *  - `Storage.put` is atomic (write-then-rename in `FsStorage`; see storage.ts) — a reader
 *    never observes a torn file from a single write, so this module doesn't have to guard
 *    against half-written YAML/JSON of its *own* making.
 *  - Everything loaded from disk is still validated with zod before use (§13). Atomicity
 *    only protects one `put`; it says nothing about a file written by an older version of
 *    this code, hand-edited, or corrupted by something outside this process. `open()`
 *    degrades — warns and starts a fresh sweep, or drops the bad rows — rather than
 *    throwing, because a worker that needs a manual `rm` to restart is worse than a resweep.
 *
 * Known, accepted limitation: a renamed or transferred repo leaves its old detail YAML and
 * old `hashes` entry orphaned — `entries` is keyed by GitHub's numeric id, `hashes` by
 * `full_name`, so the two desynchronise (the id resolves to the new name; the stale name's
 * hash entry and detail file just sit there, unreferenced). This is slow to bite and
 * self-heals on `--fresh`; a pruning pass needs a "not seen this sweep" mark-and-sweep this
 * task doesn't build. This paragraph is the record of that decision, not a TODO.
 */

/** Exactly the three fields the full list carries. */
export type ListEntry = { id: number; path: string; name: string };

export type DetailDoc = {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  language: string | null;
  license: string | null;
  topics: string[];
  archived: boolean;
  fork: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  discovered_via: string;
  discovered_at: string;
  payload_hash: string;
};

export type FailedWindow = { window: string; error: string };

export type DiscoveryState = {
  query: string;
  started_at: string;
  /**
   * The live queue, serialised. Without it a resume loses every window produced by
   * subdivision: the parent is recorded complete and its children existed only in memory.
   */
  pending_windows: Window[];
  completed_windows: string[];
  failed_windows: FailedWindow[];
  repos_seen: number;
  /**
   * Pages asked for, not HTTP requests made: `SearchClient.page()` retries throttles and
   * transient failures internally, so this reads low exactly when the budget is under the most
   * pressure. Named for what it actually counts.
   */
  pages_fetched: number;
  /** Search items GitHub returned that failed per-item validation. Nothing drops silently (§13). */
  dropped: number;
};

export type RecordOutcome = 'new' | 'changed' | 'unchanged';

export type DiscoveryLogger = { warn(fields: object, message: string): void };
const noopLogger: DiscoveryLogger = { warn: () => {} };

/**
 * Structural mirrors of `windows.ts`'s `Created`/`Window`, needed here to validate state
 * loaded from disk (§13) — this file owns `discovery/`'s reads, so it owns their schemas too.
 * The `z.ZodType<Created>` / `z.ZodType<Window>` annotations are load-bearing, not decoration:
 * if `windows.ts` ever grows a `Created` variant or a `Window` field, this file fails to
 * *compile* until the schema catches up — the same belt-and-suspenders `pinning.test.ts` uses
 * for the taxonomy (§6), so a drift here can't silently start rejecting (or worse, accepting
 * garbage as) real windows.
 */
const CreatedSchema: z.ZodType<Created> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('years'), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('year'), year: z.number() }),
  z.object({ kind: z.literal('quarter'), year: z.number(), quarter: z.number() }),
  z.object({ kind: z.literal('month'), year: z.number(), month: z.number() }),
  z.object({ kind: z.literal('day'), date: z.string() }),
]);

const WindowSchema: z.ZodType<Window> = z.object({
  base: z.string(),
  stars: z.string(),
  created: CreatedSchema.nullable(),
});

const FailedWindowSchema: z.ZodType<FailedWindow> = z.object({
  window: z.string(),
  error: z.string(),
});

const DiscoveryStateSchema: z.ZodType<DiscoveryState> = z.object({
  query: z.string(),
  started_at: z.string(),
  pending_windows: z.array(WindowSchema),
  completed_windows: z.array(z.string()),
  failed_windows: z.array(FailedWindowSchema),
  repos_seen: z.number(),
  pages_fetched: z.number(),
  // `.default(0)` rather than required: a counter added after the fact must not invalidate a
  // state file mid-sweep. zod backfills it, so an older `_state.json` resumes instead of being
  // rejected by `loadState` and degraded to a full resweep.
  dropped: z.number().default(0),
});

const ListEntrySchema: z.ZodType<ListEntry> = z.object({
  id: z.number(),
  path: z.string(),
  name: z.string(),
});

const HashesSchema = z.record(z.string(), z.string());

/**
 * Reads `_state.json`, validated. Returns `null` — never throws — for anything that isn't a
 * clean, schema-valid state: missing file, torn/truncated JSON (`JSON.parse` throws on that,
 * and would otherwise crash every future run the same way), or a shape zod rejects (a
 * `pending_windows` entry with the wrong field types, an unknown `Created.kind`, …). The
 * caller treats `null` as "start a fresh sweep," which is always safe — GitHub Search is the
 * source of truth; this file is only ever a resume optimisation.
 */
async function loadState(cache: Cache, logger: DiscoveryLogger): Promise<DiscoveryState | null> {
  const raw = await cache.getText(discoveryKeys.state);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn(
      { key: discoveryKeys.state, error: String(error) },
      'discovery: state file is corrupt JSON — starting a fresh sweep instead of wedging',
    );
    return null;
  }

  const result = DiscoveryStateSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { key: discoveryKeys.state, issues: result.error.issues.slice(0, 5) },
      'discovery: state file failed validation — starting a fresh sweep instead of wedging',
    );
    return null;
  }
  return result.data;
}

/**
 * Reads `repos-full-list.yaml`, dropping — never throwing on — a row that doesn't parse to
 * the documented shape. A torn write can leave the array truncated mid-row, a row missing a
 * field, or (worst case) the whole array reduced to unrelated garbage; all three degrade to
 * "drop what's unusable, keep what parses," logged, rather than crashing or silently
 * round-tripping a bad row back to disk on the next flush.
 */
async function loadList(cache: Cache, logger: DiscoveryLogger): Promise<ListEntry[]> {
  const text = await cache.getText(discoveryKeys.fullList);
  if (text === null) return [];

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    logger.warn(
      { key: discoveryKeys.fullList, error: String(error) },
      'discovery: full list is unreadable YAML — treating it as empty',
    );
    return [];
  }
  if (!Array.isArray(raw)) {
    logger.warn(
      { key: discoveryKeys.fullList, got: typeof raw },
      'discovery: full list did not parse to an array — treating it as empty',
    );
    return [];
  }

  const entries: ListEntry[] = [];
  let dropped = 0;
  for (const row of raw) {
    const result = ListEntrySchema.safeParse(row);
    if (result.success) entries.push(result.data);
    else dropped += 1;
  }
  if (dropped > 0) {
    logger.warn(
      { dropped, kept: entries.length, key: discoveryKeys.fullList },
      'discovery: dropped malformed rows from the full list on load',
    );
  }
  return entries;
}

/**
 * Reads `_hashes.json`. Corrupt JSON or the wrong shape degrades to an empty map — every
 * repo looks changed once, which costs a rewrite, not a crash or a lost repo.
 */
async function loadHashes(cache: Cache, logger: DiscoveryLogger): Promise<Map<string, string>> {
  const text = await cache.getText(discoveryKeys.hashes);
  if (text === null) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger.warn(
      { key: discoveryKeys.hashes, error: String(error) },
      'discovery: hash index is corrupt JSON — treating it as empty',
    );
    return new Map();
  }

  const result = HashesSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { key: discoveryKeys.hashes },
      'discovery: hash index failed validation — treating it as empty',
    );
    return new Map();
  }
  return new Map(Object.entries(result.data));
}

/**
 * Covers every field except `discovered_via`, `discovered_at` and `payload_hash` itself.
 *
 * `discovered_at` is excluded because including it would make every document look changed on
 * every run, defeating the rewrite policy outright.
 *
 * `discovered_via` is excluded because it is provenance, not content, and it is *unstable by
 * construction*: a window over 1000 results contributes its 100 probe items under the parent's
 * query and then subdivides, so a child window re-sees those same repos under a different
 * query string. With `via` in the hash, a resumed sweep rewrote every one of them — measured at
 * 100 spurious `changed` documents on a 3000-repo corpus, which is tens of thousands of
 * pointless writes at real scale. Excluding it makes the documented first-wins rule actually
 * hold: the stored `discovered_via` is the first sighting's window and is deliberately never
 * updated, even when a later window re-sees the repo.
 *
 * `stars` IS included, unlike `contentHash` in @keco/cache which deliberately excludes it.
 * The two serve different purposes: contentHash gates expensive re-analysis, so star churn
 * must not trigger it; this hash gates a file write whose whole content is that star count,
 * so excluding it would leave the document asserting a number the search no longer reports.
 * The practical consequence is that a weekly sweep rewrites most documents — correct, and the
 * reason the skip mostly pays off on same-day re-runs and resumes.
 */
export function toDetail(item: SearchItem, via: string, discoveredAt: string): DetailDoc {
  const content = {
    id: item.id,
    full_name: item.full_name,
    name: item.name,
    owner: item.owner?.login ?? item.full_name.split('/')[0] ?? '',
    description: item.description ?? null,
    homepage: item.homepage ?? null,
    stars: item.stargazers_count,
    forks: item.forks_count,
    open_issues: item.open_issues_count,
    language: item.language ?? null,
    license: item.license?.spdx_id ?? null,
    topics: [...item.topics].sort(),
    archived: item.archived,
    fork: item.fork,
    default_branch: item.default_branch,
    created_at: item.created_at,
    updated_at: item.updated_at,
    pushed_at: item.pushed_at ?? null,
  };
  const payload_hash = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
    .slice(0, 32);
  // Field order is the documented document shape; `discovered_via` stays where it was.
  return { ...content, discovered_via: via, discovered_at: discoveredAt, payload_hash };
}

/**
 * Stable, locale-independent row order. `String#localeCompare` is ICU-collation-dependent, so
 * the same data can sort differently machine to machine — which would make every flush look
 * like a spurious diff to anything that snapshots `repos-full-list.yaml` (code review, `git
 * diff`, a CI check). Plain codepoint comparison is deterministic everywhere Node runs.
 */
const byPath = (a: ListEntry, b: ListEntry): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export class DiscoveryStore {
  /**
   * Repos already recorded during this process. Star bands and date windows do not overlap
   * in principle, but a window that exceeded 1000 contributes its first 100 results and then
   * subdivides, so its children re-yield those same repos. This set is what makes the
   * documented first-wins rule hold *within* a run; `payload_hash` (which deliberately excludes
   * `discovered_via`) is what makes it hold *across* runs, so a resume cannot rewrite a
   * document just because a child window re-sighted it.
   *
   * First-wins also means a document can be up to one sweep stale: if a repo's real data
   * changes between its first (owning) window recording it and a later window that would
   * otherwise re-see it, the later, fresher data is discarded for this sweep. Accepted
   * trade — comparing sightings to keep the "best" one needs a definition of "best" this
   * design doesn't have, and the staleness self-heals on the very next sweep.
   */
  private readonly seenThisRun = new Set<number>();

  /** Flush cadence — 25 windows or 30s since the last flush, whichever comes first. See
   * `windowCompleted`'s doc comment for why. */
  private static readonly FLUSH_WINDOW_COUNT = 25;
  private static readonly FLUSH_INTERVAL_MS = 30_000;

  private windowsSinceFlush = 0;
  private lastFlushAt: number;

  /**
   * Serialises overlapping `flush()` calls — the shutdown handler's and the loop's can be in
   * flight at once. Without it the two interleave *within* one flush: the list is snapshotted
   * before the first await but `hashes` and `state` are read after it, so if the earlier
   * flush's list write lands last you get a list missing a window's repos alongside a state
   * that marks that window complete. Nothing would ever refetch them. Same shape as
   * `RatePacer.queue` in packages/github/src/search.ts, including the `.catch` so one failed
   * flush cannot poison every later one.
   */
  private flushing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly cache: Cache,
    private readonly entries: Map<number, ListEntry>,
    private readonly hashes: Map<string, string>,
    readonly state: DiscoveryState,
    openedAt: Date,
  ) {
    this.lastFlushAt = openedAt.getTime();
  }

  /**
   * Loads prior artifacts unless `fresh`. Refuses — throws — to open state written for a
   * *different* query, because silently proceeding would overwrite that corpus's full list
   * and hash index the moment this run flushes; `{ fresh: true }` is the explicit escape
   * hatch for "yes, start over in this cache dir." Unreadable or schema-invalid state (as
   * opposed to valid state for the wrong query) is a different failure and degrades instead
   * of throwing — see `loadState`.
   */
  static async open(
    cache: Cache,
    query: string,
    options: { fresh?: boolean; now?: Date; logger?: DiscoveryLogger } = {},
  ): Promise<DiscoveryStore> {
    const now = options.now ?? new Date();
    const logger = options.logger ?? noopLogger;

    const storedState = options.fresh ? null : await loadState(cache, logger);

    if (storedState !== null && storedState.query !== query) {
      throw new Error(
        `discovery state at "${discoveryKeys.state}" belongs to query "${storedState.query}", ` +
          `not "${query}". Opening it as-is would overwrite that corpus's ` +
          `${discoveryKeys.fullList} and ${discoveryKeys.hashes} with this query's results. ` +
          'Pass { fresh: true } (or --fresh) to start a new sweep in this cache dir, or point ' +
          'CACHE_DIR at a different directory.',
      );
    }

    const entries = new Map<number, ListEntry>();
    const hashes = new Map<string, string>();

    if (storedState !== null) {
      // Only load the corpus once we have validated, matching state to resume — list.yaml
      // and hashes.json carry no query of their own, so without state confirming they're
      // for *this* query, trusting them could silently mix two corpora. Unreadable state
      // (loadState's degrade path) means a full resweep, not a best-effort partial load of a
      // corpus this run can no longer attribute to a query.
      for (const entry of await loadList(cache, logger)) entries.set(entry.id, entry);
      for (const [repo, hash] of await loadHashes(cache, logger)) hashes.set(repo, hash);
    }

    const state: DiscoveryState = storedState ?? {
      query,
      started_at: now.toISOString(),
      pending_windows: [],
      completed_windows: [],
      failed_windows: [],
      repos_seen: 0,
      pages_fetched: 0,
      dropped: 0,
    };

    return new DiscoveryStore(cache, entries, hashes, state, now);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Records one search hit, writing its detail document only when the payload changed.
   * The first window to find a repo owns its `discovered_via`; later sightings are dropped.
   * The `entries` check also covers a torn flush, where hashes landed but the list did not.
   */
  async record(item: SearchItem, via: string, now = new Date()): Promise<RecordOutcome> {
    if (this.seenThisRun.has(item.id)) return 'unchanged';
    const doc = toDetail(item, via, now.toISOString());
    const known = this.entries.has(doc.id);
    if (known && this.hashes.get(doc.full_name) === doc.payload_hash) {
      this.seenThisRun.add(doc.id);
      return 'unchanged';
    }

    await this.cache.putText(
      discoveryKeys.detail(doc.full_name),
      stringify(doc),
      'application/yaml',
    );
    this.hashes.set(doc.full_name, doc.payload_hash);
    this.entries.set(doc.id, { id: doc.id, path: doc.full_name, name: doc.name });
    this.seenThisRun.add(doc.id);
    return known ? 'changed' : 'new';
  }

  /**
   * Call once a window's results have all been recorded — windows, not records, are the
   * unit the flush policy counts in, because a window is also the retry granularity: on
   * resume an incomplete window is refetched from GitHub Search whole, not repo-by-repo, so
   * there's no finer-grained notion of "progress" to flush against.
   *
   * Flushes only when 25 windows have completed or 30 seconds have passed since the last
   * flush, whichever comes first. Serialising and writing the full corpus after *every*
   * window measured at ~950ms / 10.9MB at 100k entries, dominated by YAML stringification —
   * a real tax against a window that can cost as little as the ~2s of search pacing for one
   * page. The policy's worst case (a kill mid-run) is bounded and cheap: replaying up to 30
   * already-paced seconds of windows, far less than the writes this saves over a sweep.
   *
   * The orchestrator owns *calling* this after every window; it does not own *deciding*
   * whether that call actually writes — that policy lives here so it changes in one place.
   * `flush()` remains available and is the unconditional path the orchestrator must use at
   * sweep end and around a caught error: "safe to kill at any moment" (§4) means the
   * artifacts have to be durable before the process is allowed to exit, on any path out.
   *
   * Returns whether a flush actually ran, so a caller or test can assert on it without
   * reaching into private counters.
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

  /**
   * Writes all three shared artifacts, unconditionally, in this order: full list, then hash
   * index, then state. The order is load-bearing, not incidental — `state.completed_windows`
   * is the resume decision (which windows the orchestrator skips on restart), so it must
   * never become durable ahead of the list/hash entries it claims are recorded. Each
   * individual `put` is atomic (storage.ts), so the only remaining failure mode is a kill
   * *between* these three calls — and because state is last, that always leaves state either
   * fully caught up or, safely, one step behind, describing a smaller but still-true set of
   * completed work. Reversing the order would let state advance past data that was never
   * written: repos silently missing from the file the crawler reads, with nothing to signal
   * it. See `store.test.ts`'s "flush crash-safety" suite, which pins both the order and the
   * recovery.
   */
  async flush(now = new Date()): Promise<void> {
    const turn = this.flushing.then(() => this.writeAll(now));
    this.flushing = turn.catch(() => undefined);
    return turn;
  }

  private async writeAll(now: Date): Promise<void> {
    // Read at the instant of the write, not cached from an earlier record() — anything else
    // could drift from what's actually about to be persisted below.
    this.state.repos_seen = this.entries.size;
    const list = [...this.entries.values()].sort(byPath);
    await this.cache.putText(discoveryKeys.fullList, stringify(list), 'application/yaml');
    await this.cache.putJSON(discoveryKeys.hashes, Object.fromEntries(this.hashes));
    await this.cache.putJSON(discoveryKeys.state, this.state);
    this.windowsSinceFlush = 0;
    this.lastFlushAt = now.getTime();
  }
}
