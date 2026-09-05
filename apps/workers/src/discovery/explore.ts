import type { DataStore, Document, Sort } from '../lib/data-store';
import { DISCOVERY_COLLECTIONS, REPOS, RUNS, STATE, slugifyQuery } from './store/collections';

/**
 * `kecoctl discovery count | list | reset` — reading and clearing the discovery dataset.
 *
 * Data access only; `explore-format.ts` renders. Everything goes through the `DataStore`
 * port, never a backend, so all three commands keep working under `DISCOVERY_STORE=fs` —
 * which also means the whole module is testable against `InMemoryDataStore`.
 */

export type LastRun = { run_id: string; started_at: string; outcome: string };

export type CountRow = {
  query: string;
  query_slug: string;
  repos: number;
  runs: number;
  pending_windows: number;
  last_run: LastRun | null;
};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/**
 * The set of swept queries comes from `discovery_state`, one document per query. It is the
 * only cheap enumeration available: the port has no `distinct` and no facets, and scanning
 * the repo collection to learn that two queries exist would read 31k documents for a number.
 *
 * The consequence is that a query is listed from the moment its first sweep opens, before any
 * repo or run document lands. That is correct — a sweep killed in its first seconds is
 * exactly what someone runs this command to find.
 */
export async function countDiscovery(
  dataStore: DataStore,
  options: { query: string | null },
): Promise<CountRow[]> {
  const slug = options.query === null ? null : slugifyQuery(options.query);

  const states: Document[] = [];
  for await (const row of dataStore.list(STATE, slug === null ? {} : { where: { query_slug: slug } })) {
    states.push(row);
  }
  // Ordered by slug: a table whose row order changes between runs is a table nobody trusts.
  states.sort((a, b) => (asString(a.query_slug) < asString(b.query_slug) ? -1 : 1));

  const rows: CountRow[] = [];
  for (const state of states) {
    const querySlug = asString(state.query_slug);
    const where = { query_slug: querySlug };
    rows.push({
      query: asString(state.query, querySlug),
      query_slug: querySlug,
      repos: await dataStore.count(REPOS, where),
      runs: await dataStore.count(RUNS, where),
      pending_windows: Array.isArray(state.pending_windows) ? state.pending_windows.length : 0,
      last_run: await lastRunOf(dataStore, querySlug),
    });
  }
  return rows;
}

async function lastRunOf(dataStore: DataStore, querySlug: string): Promise<LastRun | null> {
  for await (const row of dataStore.list(RUNS, {
    where: { query_slug: querySlug },
    sort: [['started_at', 'desc']],
    fields: ['run_id', 'started_at', 'outcome'],
    limit: 1,
  })) {
    return {
      run_id: asString(row.run_id),
      started_at: asString(row.started_at),
      outcome: asString(row.outcome, 'unknown'),
    };
  }
  return null;
}

/** The default ordering per collection: newest runs, biggest repos. */
const DEFAULT_SORT: Record<string, Sort> = {
  [RUNS]: [['started_at', 'desc']],
  [REPOS]: [['stars', 'desc']],
};

/**
 * Turns `--sort` into a `Sort`, refusing anything the collection did not declare sortable.
 *
 * Rejecting by name matters more than it looks: a backend given an undeclared sort field
 * either errors deep in a client stack or quietly returns unsorted results, and the second
 * failure shows the operator a table that looks sorted and is not.
 */
export function resolveSort(collection: string, sort: string | null): Sort {
  if (sort === null) return DEFAULT_SORT[collection] ?? [];

  const spec = DISCOVERY_COLLECTIONS.find((candidate) => candidate.name === collection);
  const sortable = spec?.sortable ?? [];
  const [field = '', direction = 'desc'] = sort.split(':');

  if (!sortable.includes(field)) {
    throw new Error(
      `cannot sort ${collection} by "${field}" — sortable fields are: ${sortable.join(', ')}`,
    );
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error(`sort direction must be asc or desc, got "${direction}"`);
  }
  return [[field, direction]];
}

export type ListOptions = { query: string | null; limit: number; sort: string | null };
export type ListResult = { rows: Document[]; total: number };

/**
 * `total` is the count *before* the limit, so the caller can say "showing 20 of 31,204". A
 * capped table that reports its own length as the total is worse than no table.
 */
async function listCollection(
  dataStore: DataStore,
  collection: string,
  options: ListOptions,
): Promise<ListResult> {
  const where =
    options.query === null ? undefined : { query_slug: slugifyQuery(options.query) };

  const rows: Document[] = [];
  for await (const row of dataStore.list(collection, {
    ...(where === undefined ? {} : { where }),
    sort: resolveSort(collection, options.sort),
    limit: options.limit,
  })) {
    rows.push(row);
  }

  return { rows, total: await dataStore.count(collection, where) };
}

export const listRuns = (dataStore: DataStore, options: ListOptions): Promise<ListResult> =>
  listCollection(dataStore, RUNS, options);

export const listRepos = (dataStore: DataStore, options: ListOptions): Promise<ListResult> =>
  listCollection(dataStore, REPOS, options);

export type ResetOptions = { query: string | null; all: boolean; includeRuns: boolean };

export type ResetPlan = {
  query: string;
  query_slug: string;
  repos: number;
  state: number;
  runs: number;
  delete_runs: boolean;
};

/**
 * Works out what a reset would destroy, without destroying anything. The CLI prints this and
 * then asks — an operator confirms against what is actually there, not against what they
 * assumed was there.
 *
 * Refuses with no target: `--query` names one, `--all` means every query, and there is no
 * default. A reset that defaults to everything is a reset that eventually runs by accident,
 * and unlike the read model this data is not rebuildable offline.
 */
export async function planReset(
  dataStore: DataStore,
  options: ResetOptions,
): Promise<ResetPlan[]> {
  if (options.query === null && !options.all) {
    throw new Error(
      'refusing to reset without a target — pass --query <keyword> for one query, or --all for every query',
    );
  }

  const rows = await countDiscovery(dataStore, { query: options.query });
  return rows.map((row) => ({
    query: row.query,
    query_slug: row.query_slug,
    repos: row.repos,
    state: 1,
    runs: row.runs,
    delete_runs: options.includeRuns,
  }));
}

/**
 * Applies a plan. Corpus first, then state, then — only if asked — the history.
 *
 * State goes after the corpus for the same reason a flush writes it last: if this is
 * interrupted halfway, a surviving state document pointing at a partly-deleted corpus is
 * recoverable (the next sweep re-records what is missing), whereas a deleted state document
 * over a surviving corpus would strand 31k rows that nothing will ever clean up.
 */
export async function applyReset(dataStore: DataStore, plans: readonly ResetPlan[]): Promise<void> {
  for (const plan of plans) {
    const where = { query_slug: plan.query_slug };
    await dataStore.remove(REPOS, where);
    await dataStore.remove(STATE, where);
    if (plan.delete_runs) await dataStore.remove(RUNS, where);
  }
}
