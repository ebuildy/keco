import type { CollectionSpec, Document } from '../../lib/data-store';

/**
 * The crawl run history, declared as data — the same shape `discovery/store/collections.ts`
 * uses for sweeps. Nothing here touches a DataStore, a backend or the network.
 *
 * This is **write-model** data that happens to share the Meilisearch instance, exactly like the
 * `discovery_*` collections: the read side never queries it, and the projector remains the only
 * writer of searchable read models (AGENTS.md §5, docs/adr/0002-discovery-datastore.md).
 *
 * It is deliberately NOT per-repo. §5 assigns per-repo pipeline status to `repos_state`, owned
 * by the projector, and per-repo skip and failure facts are already durable in the journal.
 */

export const CRAWL_HISTORY = 'crawl_history';

/**
 * `searchable: []` makes this a plain key-value store per §5: no inverted index, minimal RAM,
 * still filterable and sortable. Nothing full-text-searches a run record.
 */
export const CRAWL_COLLECTIONS: readonly CollectionSpec[] = [
  {
    name: CRAWL_HISTORY,
    primaryKey: 'run_id',
    searchable: [],
    filterable: ['outcome'],
    sortable: ['started_at', 'duration_ms', 'repos_fetched', 'requests'],
  },
];

export type CrawlOutcome = 'running' | 'complete' | 'failed' | 'interrupted';

/**
 * `requests` counts the calls the fetch pipeline accounts for: GitHub REST calls plus raw
 * manifest fetches. Icon fetches are NOT included — `updateIcon` does not report a request
 * count, and inventing one here would be a number nobody could reconcile.
 *
 * `points_spent` counts only the calls that consumed GitHub REST quota: 304s and
 * raw.githubusercontent.com fetches are excluded, because both are free and a number that
 * conflated them would make the 304 short-circuit invisible in exactly the record an operator
 * reads to confirm it is working.
 */
export type CrawlCounters = {
  repos_seen: number;
  repos_fetched: number;
  repos_unchanged: number;
  repos_skipped: number;
  repos_failed: number;
  icons_updated: number;
  requests: number;
  points_spent: number;
  rate_limited: number;
};

export const emptyCounters = (): CrawlCounters => ({
  repos_seen: 0,
  repos_fetched: 0,
  repos_unchanged: 0,
  repos_skipped: 0,
  repos_failed: 0,
  icons_updated: 0,
  requests: 0,
  points_spent: 0,
  rate_limited: 0,
});

export type CrawlRunInput = {
  runId: string;
  startedAt: Date;
  limit: number | null;
  repo: string | null;
  shardCount: number;
  shardIndex: number;
  outcome: CrawlOutcome;
  endedAt?: Date;
  counters?: CrawlCounters;
};

export function toCrawlRunDocument(input: CrawlRunInput): Document {
  const endedAt = input.endedAt ?? null;
  const counters = input.counters ?? emptyCounters();
  return {
    run_id: input.runId,
    started_at: input.startedAt.toISOString(),
    finished_at: endedAt === null ? null : endedAt.toISOString(),
    duration_ms: endedAt === null ? null : endedAt.getTime() - input.startedAt.getTime(),
    outcome: input.outcome,
    // The run's configuration, so a short run explains itself without anyone guessing.
    limit: input.limit,
    repo: input.repo,
    shard_count: input.shardCount,
    shard_index: input.shardIndex,
    ...counters,
  };
}
