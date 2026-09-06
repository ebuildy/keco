import type { DataStore, Document } from '../../lib/data-store';
import { formatDuration, number, table, text } from '../../lib/table';
import { CRAWL_COLLECTIONS, CRAWL_HISTORY } from './collections';

/**
 * Reading the crawl run history — `kecoctl repo history`. The mirror of
 * `discovery/explore.ts` for sweeps.
 *
 * `ensure()` first: every DataStore implementation refuses an unknown collection by design, and
 * `repo history` on a fresh machine has no crawl in front of it to create one. Missing this in
 * the discovery explore commands was invisible against Meilisearch, where a previous sweep had
 * already created the indexes, and only surfaced under `DISCOVERY_STORE=fs`.
 */

export type ListCrawlsOptions = { limit: number };
export type ListCrawlsResult = { rows: Document[] };

export async function listCrawls(
  dataStore: DataStore,
  { limit }: ListCrawlsOptions,
): Promise<ListCrawlsResult> {
  await dataStore.ensure(CRAWL_COLLECTIONS);

  const rows: Document[] = [];
  for await (const document of dataStore.list(CRAWL_HISTORY, {
    sort: [['started_at', 'desc']],
    limit,
  })) {
    rows.push(document);
  }
  return { rows };
}

export function formatHistory({ rows }: ListCrawlsResult): string {
  if (rows.length === 0) {
    return 'no crawl runs recorded yet — `mise run repo:crawl` writes one per run';
  }

  return table(
    rows.map((row) => ({
      RUN: text(row.run_id),
      STARTED: text(row.started_at).replace('T', ' ').slice(0, 19),
      TOOK: formatDuration(typeof row.duration_ms === 'number' ? row.duration_ms : null),
      OUTCOME: text(row.outcome),
      SEEN: number(row.repos_seen),
      FETCHED: number(row.repos_fetched),
      UNCHANGED: number(row.repos_unchanged),
      SKIPPED: number(row.repos_skipped),
      FAILED: number(row.repos_failed),
      ICONS: number(row.icons_updated),
      // Separate columns on purpose: conflating them would make the 304 short-circuit
      // invisible in exactly the record that exists to confirm it works.
      REQ: number(row.requests),
      POINTS: number(row.points_spent),
      SEED_ERRORS: seedErrors(row.seed_errors),
    })),
  );
}

function seedErrors(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '—';
  return (value as { name?: unknown }[])
    .map((entry) => String(entry?.name ?? '?'))
    .join(',');
}
