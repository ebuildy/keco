import type { DataStore, Document } from '../lib/data-store';
import { REPOS, RUNS, STATE, slugifyQuery } from './store/collections';

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
