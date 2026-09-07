import { createHash } from 'node:crypto';
import type { SearchItem } from '@keco/github';
import type { CollectionSpec, Document } from '../../lib/data-store';
import type { Window } from '../windows';

/**
 * Discovery's data, declared as data (AGENTS.md §4.1). Nothing here touches a DataStore, a
 * backend or the network: it is the three collection specs, the slug, the document ids and
 * every mapper, all pure and all trivially testable.
 *
 * These are *write-model* collections. They are not a read model and nothing on the read side
 * queries them — see docs/adr/0002-discovery-datastore.md for why that distinction is what
 * makes this design legal under §2.
 */

export const REPOS = 'discovery_repos';
export const RUNS = 'discovery_runs';
export const STATE = 'discovery_state';

/**
 * `discovery_repos` is the one searchable collection, so a human or the backoffice can query
 * raw discovery output before it is ever projected. Note the port has no `search()` — this
 * declaration provisions the index; it does not give any worker a relevance query.
 *
 * `discovery_runs` and `discovery_state` declare `searchable: []`, which per AGENTS.md §5
 * makes them plain key-value stores: no inverted index, minimal RAM, still filterable.
 */
export const DISCOVERY_COLLECTIONS: readonly CollectionSpec[] = [
  {
    name: REPOS,
    primaryKey: 'id',
    searchable: ['name', 'full_name', 'description', 'topics'],
    // `owner` is filterable so `kecoctl repo crawl --repo <org>` (crawler/worklist.ts) can look
    // up every repo already discovered under an org without a full collection scan.
    filterable: ['query_slug', 'archived', 'fork', 'language', 'owner'],
    sortable: ['stars', 'pushed_at'],
  },
  {
    name: RUNS,
    primaryKey: 'run_id',
    searchable: [],
    filterable: ['query_slug', 'outcome'],
    sortable: ['started_at', 'duration_ms', 'repos_new', 'pages_fetched'],
  },
  {
    name: STATE,
    primaryKey: 'query_slug',
    searchable: [],
    filterable: ['query_slug'],
    sortable: ['updated_at'],
  },
];

/**
 * Long enough for any real keyword, short enough to keep a composite document id well inside
 * every backend's key length limit.
 */
const MAX_SLUG_LENGTH = 100;

/**
 * `--query` is free text that becomes part of a document id, so it is a validation surface as
 * much as a naming one. Lowercase, collapse every run of non-alphanumerics to one `-`, trim,
 * truncate; anything left with no alphanumerics at all is refused.
 *
 * Deliberately lossy, so two queries CAN share one namespace — `kubernetes operator` and
 * `kubernetes-operator` both give `kubernetes-operator`. Accepted: colliding queries are
 * near-identical searches whose union is still a valid candidate corpus. A disambiguating
 * hash suffix would fix it at the cost of making every slug unguessable, which is a bad trade
 * for a value an operator types into `--query`.
 *
 * Moved here from packages/cache/src/keys.ts, which no longer has a discovery key to build.
 */
export function slugifyQuery(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  if (slug === '') {
    throw new Error(
      `discovery query ${JSON.stringify(query)} has no ASCII alphanumeric characters, so it ` +
        'has no collection namespace. Pass a keyword such as --query kubernetes.',
    );
  }
  return slug;
}

/**
 * Underscore, never a colon: document ids are `[A-Za-z0-9_-]` only (see `assertDocumentId`).
 * Slugs contain no underscores and repo ids are numeric, so `{slug}_{id}` cannot collide
 * between two queries.
 */
export const repoDocumentId = (querySlug: string, repoId: number): string =>
  `${querySlug}_${repoId}`;

// ── repo documents ───────────────────────────────────────────────────────────

export type DetailDoc = {
  repo_id: number;
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

/**
 * Covers every field except `discovered_via`, `discovered_at` and `payload_hash` itself.
 *
 * `discovered_at` is excluded because including it would make every document look changed on
 * every run, defeating the rewrite policy outright.
 *
 * `discovered_via` is excluded because it is provenance, not content, and it is *unstable by
 * construction*: a window over 1000 results contributes its 100 probe items under the
 * parent's query and then subdivides, so a child window re-sees those repos under a different
 * query string. With `via` in the hash, a resumed sweep rewrote every one of them — measured
 * at 100 spurious `changed` documents on a 3000-repo corpus.
 *
 * `stars` IS included, unlike `contentHash` in @keco/cache which deliberately excludes it.
 * The two gate different things: `contentHash` gates expensive re-analysis, so star churn
 * must not trigger it; this hash gates a write whose whole content is that star count.
 */
export function toDetail(item: SearchItem, via: string, discoveredAt: string): DetailDoc {
  const content = {
    repo_id: item.id,
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
  return { ...content, discovered_via: via, discovered_at: discoveredAt, payload_hash };
}

export type RepoDocumentContext = {
  query: string;
  querySlug: string;
  runId: string;
  /** The run that first saw this repo. Equals `runId` for a new repo. */
  firstSeenRunId: string;
};

export function toRepoDocument(detail: DetailDoc, context: RepoDocumentContext): Document {
  return {
    ...detail,
    id: repoDocumentId(context.querySlug, detail.repo_id),
    query: context.query,
    query_slug: context.querySlug,
    first_seen_run_id: context.firstSeenRunId,
    last_seen_run_id: context.runId,
  };
}

// ── state documents ──────────────────────────────────────────────────────────

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
   * Pages asked for, not HTTP requests made: `SearchClient.page()` retries throttles
   * internally, so this reads low exactly when the budget is under the most pressure.
   */
  pages_fetched: number;
  /** Search items GitHub returned that failed per-item validation. Nothing drops silently. */
  dropped: number;
};

export function toStateDocument(
  state: DiscoveryState,
  context: { querySlug: string; runId: string; now: Date },
): Document {
  return {
    query_slug: context.querySlug,
    query: state.query,
    started_at: state.started_at,
    updated_at: context.now.toISOString(),
    current_run_id: context.runId,
    // structuredClone, not a spread: these are the arrays runDiscovery is actively mutating,
    // and a shallow copy of the *outer* array still shares every Window object inside it.
    pending_windows: structuredClone(state.pending_windows),
    completed_windows: [...state.completed_windows],
    failed_windows: structuredClone(state.failed_windows),
    repos_seen: state.repos_seen,
    pages_fetched: state.pages_fetched,
    dropped: state.dropped,
  };
}

// ── run documents ────────────────────────────────────────────────────────────

export type RunOutcome = 'running' | 'complete' | 'failed' | 'interrupted';

/**
 * One catastrophic sweep can fail every window it touches. The counter stays exact; the
 * detail list is capped so a run document cannot grow unbounded.
 */
const MAX_RECORDED_FAILED_WINDOWS = 50;

export type RunDocumentInput = {
  runId: string;
  query: string;
  querySlug: string;
  startedAt: Date;
  fresh: boolean;
  limit: number | null;
  outcome: RunOutcome;
  endedAt?: Date;
  counts?: { new: number; changed: number; unchanged: number };
  pagesFetched?: number;
  dropped?: number;
  windowsCompleted?: number;
  windowsFailed?: number;
  sweepReposTotal?: number;
  sweepWindowsPending?: number;
  stoppedAtLimit?: boolean;
  failedWindows?: readonly FailedWindow[];
};

export function toRunDocument(input: RunDocumentInput): Document {
  const endedAt = input.endedAt ?? null;
  return {
    run_id: input.runId,
    query: input.query,
    query_slug: input.querySlug,
    started_at: input.startedAt.toISOString(),
    ended_at: endedAt === null ? null : endedAt.toISOString(),
    duration_ms: endedAt === null ? null : endedAt.getTime() - input.startedAt.getTime(),
    outcome: input.outcome,
    fresh: input.fresh,
    limit: input.limit,
    // Run-scoped, never sweep-scoped: these count only this process. Reporting "742 pages"
    // when 742 covers two resumed runs is worse than reporting neither.
    pages_fetched: input.pagesFetched ?? 0,
    dropped: input.dropped ?? 0,
    repos_new: input.counts?.new ?? 0,
    repos_changed: input.counts?.changed ?? 0,
    repos_unchanged: input.counts?.unchanged ?? 0,
    windows_completed: input.windowsCompleted ?? 0,
    windows_failed: input.windowsFailed ?? 0,
    // Sweep-scoped snapshots, named apart so the two scopes are never confused.
    sweep_repos_total: input.sweepReposTotal ?? 0,
    sweep_windows_pending: input.sweepWindowsPending ?? 0,
    stopped_at_limit: input.stoppedAtLimit ?? false,
    failed_windows: (input.failedWindows ?? []).slice(0, MAX_RECORDED_FAILED_WINDOWS),
  };
}
