import type { Cache } from '@keco/cache';
import { RepoRef } from '@keco/core';
import { ownsShard } from '@keco/github';
import { DISCOVERY_COLLECTIONS, REPOS } from '../discovery/store/collections';
import type { DataStore } from '../lib/data-store';
import type { SeedAdapter } from './seeds';

/**
 * Every source the crawler draws from, merged into one deduplicated, sharded, capped list
 * (AGENTS.md §4.2).
 *
 * Seeds come first: §4.2 calls registry seeds higher signal than keyword search, so a `--limit`
 * run should spend its budget on them before it touches the discovery corpus. Within the
 * corpus, the order is stars descending for the same reason — a capped run should buy the most
 * valuable repos, not an arbitrary page.
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
   * `--repo owner/name`, or a bare org — see `isOrgRef`. Either form is explicit, and every
   * other source is ignored.
   */
  repo: string | null;
  seeds: readonly SeedAdapter[];
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
  /** Records a seed that produced nothing, so a silent outage is visible on the run document. */
  onSeedError?: (name: string, error: string) => void;
  now?: () => Date;
};

export async function buildWorklist(
  options: WorklistOptions,
  deps: WorklistDeps,
): Promise<WorkItem[]> {
  // An explicit `--repo` is explicit: no shard filter, no limit, no seeds. An operator who
  // names one repo and gets nothing because it hashed to another shard has been lied to.
  // The `owner/name` form still touches no store at all — it never needed the corpus.
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

  // Same reasoning as above: the batch path below reads the same collection.
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

  for (const seed of options.seeds) {
    if (items.length >= options.limit) break;
    let refs: Awaited<ReturnType<SeedAdapter['refs']>>;
    try {
      refs = await seed.refs({
        cache: deps.cache,
        fetch: deps.fetch,
        now: deps.now,
        githubToken: deps.githubToken,
      });
    } catch (error) {
      // An adapter should degrade internally (§4.2); this catches the programming error that
      // slipped past, and a crawl of five seeds must not die for one of them.
      deps.onSeedError?.(seed.name, error instanceof Error ? error.message : String(error));
      continue;
    }

    if (refs.length === 0) {
      // Zero refs is the observable fact, and it is the one worth surfacing: an Artifact Hub
      // outage that yields nothing is otherwise indistinguishable from a quiet registry.
      deps.onSeedError?.(seed.name, 'seed yielded no refs');
      continue;
    }

    for (const ref of refs) {
      if (!take(ref.repo, ref.source)) break;
    }
  }

  if (items.length < options.limit) {
    for await (const document of deps.dataStore.list(REPOS, {
      fields: ['full_name'],
      sort: [['stars', 'desc']],
      // Over-fetch: dedupe and the shard filter both drop rows, so asking for exactly the
      // shortfall would come up short on any shard count above one.
      limit: (options.limit - items.length) * Math.max(1, options.shardCount) + items.length,
    })) {
      const fullName = document.full_name;
      if (typeof fullName !== 'string') continue;
      if (!take(fullName, 'discovery')) break;
    }
  }

  return items.slice(0, options.limit);
}

/**
 * `--repo <org>` reads the `discovery_repos` collection directly, the same one the batch path
 * above reads from — a `discovery sweep` populates it, this never touches GitHub Search.
 * Unbounded on purpose, matching the single-repo bypass's "explicit is explicit": `--limit`,
 * sharding and dedup all exist to keep a *batch* run affordable, and an operator who names one
 * org already knows the size of what they're asking for. `DataStore.list()` paginates
 * internally regardless of how many rows match, so this is safe even for a large org.
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
