import type { Cache } from '@keco/cache';
import { RepoRef } from '@keco/core';
import { ownsShard } from '@keco/github';
import { DISCOVERY_COLLECTIONS, REPOS } from '../discovery/store/collections';
import type { DataStore } from '../lib/data-store';

/**
 * What the crawler fetches, merged into one deduplicated, sharded, capped list
 * (AGENTS.md §4.2).
 *
 * GitHub is the only trust source right now: every candidate comes from the
 * `discovery_repos` collection, which a `discovery sweep` fills from GitHub Search. Registry
 * lists (CNCF landscape, krew, Artifact Hub, `awesome-*`) were an earlier "seed" mechanism that
 * fed repos into this worklist directly — removed for now (docs/adr/0004-remove-crawler-seeds.md)
 * because a foundation's own listing is corroborating evidence about a repo GitHub Search
 * already found, not proof it belongs in the corpus on its own. That data still matters; it
 * belongs in the analyzer as an enrichment signal (maturity, governance), not as a second way
 * to discover a repo.
 *
 * `REPOS` is imported from `discovery/store/collections` rather than re-declared: the collection
 * name is a shared fact, and duplicating the string is how two workers drift apart. Reading that
 * collection is explicitly sanctioned — §4.1 has the crawler read `discovery_repos` directly,
 * and ADR 0002 records why write-model data in Meilisearch is not a read model.
 */

export type WorkItem = {
  repo: string;
  /** The source that first named it. Recorded in `_fetch.json.source`. */
  source: string;
};

export type WorklistOptions = {
  /**
   * `--repo owner/name`, or a bare org — see `isOrgRef`. Either form is explicit, and bypasses
   * the discovery corpus entirely.
   */
  repo: string | null;
  limit: number;
  shardCount: number;
  shardIndex: number;
};

/** A bare `owner`/org has no slash — `owner/repo` always does. */
export const isOrgRef = (repo: string): boolean => !repo.includes('/');

export type WorklistDeps = {
  dataStore: DataStore;
  cache: Cache;
  fetch: typeof globalThis.fetch;
  githubToken?: string;
  now?: () => Date;
};

export async function buildWorklist(
  options: WorklistOptions,
  deps: WorklistDeps,
): Promise<WorkItem[]> {
  // An explicit `--repo` is explicit: no shard filter, no limit. An operator who names one repo
  // and gets nothing because it hashed to another shard has been lied to. The `owner/name` form
  // still touches no store at all — it never needed the corpus.
  if (options.repo !== null) {
    if (isOrgRef(options.repo)) {
      // Discovery owns `discovery_repos`; the crawler only ever reads it (§4.1). A crawler run
      // can be the first thing to touch a fresh Meilisearch host, and it is always the first
      // thing to run after a filterable attribute is added here — `ensure()` compares settings
      // and only reindexes on a real diff, so this is a no-op once discovery has caught up.
      await deps.dataStore.ensure(DISCOVERY_COLLECTIONS);
      return reposUnderOrg(options.repo, deps);
    }
    return [{ repo: options.repo, source: 'cli' }];
  }

  // Same reasoning as above: the corpus read below hits the same collection.
  await deps.dataStore.ensure(DISCOVERY_COLLECTIONS);

  const items: WorkItem[] = [];
  const seen = new Set<string>();

  const take = (repo: string, source: string): boolean => {
    const key = repo.toLowerCase();
    if (seen.has(key)) return items.length < options.limit;
    if (!RepoRef.safeParse(repo).success) return true;
    if (!ownsShard(repo, options.shardCount, options.shardIndex)) return true;
    seen.add(key);
    items.push({ repo, source });
    return items.length < options.limit;
  };

  for await (const document of deps.dataStore.list(REPOS, {
    fields: ['full_name'],
    sort: [['stars', 'desc']],
    // Over-fetch: dedupe and the shard filter both drop rows, so asking for exactly the limit
    // would come up short on any shard count above one.
    limit: options.limit * Math.max(1, options.shardCount),
  })) {
    const fullName = document.full_name;
    if (typeof fullName !== 'string') continue;
    if (!take(fullName, 'discovery')) break;
  }

  return items.slice(0, options.limit);
}

/**
 * `--repo <org>` reads the `discovery_repos` collection directly, the same one the batch path
 * above reads from — a `discovery sweep` populates it, this never touches GitHub Search.
 * Unbounded on purpose, matching the single-repo bypass's "explicit is explicit": `--limit` and
 * sharding both exist to keep a *batch* run affordable, and an operator who names one org
 * already knows the size of what they're asking for. `DataStore.list()` paginates internally
 * regardless of how many rows match, so this is safe even for a large org.
 *
 * Exact match on `owner`, not a prefix or a case-insensitive one: `owner` is stored exactly as
 * GitHub reports it (`toDetail()` in discovery/store/collections.ts), and Meilisearch's equality
 * filter — the collection's real backend — has no case-folding to lean on.
 */
async function reposUnderOrg(org: string, deps: WorklistDeps): Promise<WorkItem[]> {
  const items: WorkItem[] = [];
  for await (const document of deps.dataStore.list(REPOS, {
    where: { owner: org },
    fields: ['full_name'],
    sort: [['stars', 'desc']],
  })) {
    const fullName = document.full_name;
    if (typeof fullName === 'string') items.push({ repo: fullName, source: 'cli' });
  }
  return items;
}
