import { createHash } from 'node:crypto';
import { type Cache, discoveryKeys } from '@keco/cache';
import type { SearchItem } from '@keco/github';
import { parse, stringify } from 'yaml';
import type { Window } from './windows';

/**
 * Everything discovery reads and writes (design 2026-08-02). All of it through the Storage
 * port — no fs, no path building (AGENTS.md §14).
 *
 * The full list and the hash index are held in memory for the length of a run, which is what
 * makes change detection a map lookup instead of re-reading 100k YAML files per sweep. At
 * ~100k repos that is roughly 11 MB of process memory, and it buys hours.
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
  requests: number;
};

export type RecordOutcome = 'new' | 'changed' | 'unchanged';

/**
 * Covers every field except `discovered_at` and `payload_hash` itself. Including
 * `discovered_at` would make every document look changed on every run.
 *
 * `stars` IS included, unlike `contentHash` in @keco/cache which deliberately excludes it.
 * The two serve different purposes: contentHash gates expensive re-analysis, so star churn
 * must not trigger it; this hash gates a file write whose whole content is that star count,
 * so excluding it would leave the document asserting a number the search no longer reports.
 * The practical consequence is that a weekly sweep rewrites most documents — correct, and the
 * reason the skip mostly pays off on same-day re-runs and resumes.
 */
export function toDetail(item: SearchItem, via: string, discoveredAt: string): DetailDoc {
  const core = {
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
    discovered_via: via,
  };
  const payload_hash = createHash('sha256')
    .update(JSON.stringify(core))
    .digest('hex')
    .slice(0, 32);
  return { ...core, discovered_at: discoveredAt, payload_hash };
}

export class DiscoveryStore {
  /**
   * Repos already recorded during this process. Star bands and date windows do not overlap
   * in principle, but a window that exceeded 1000 contributes its first 100 results and then
   * subdivides, so its children re-yield those same repos. Without this set the second
   * sighting would differ only in `discovered_via`, hash differently, and rewrite the
   * document — one wasted write per duplicate, across the whole corpus.
   */
  private readonly seenThisRun = new Set<number>();

  private constructor(
    private readonly cache: Cache,
    private readonly entries: Map<number, ListEntry>,
    private readonly hashes: Map<string, string>,
    readonly state: DiscoveryState,
  ) {}

  /**
   * Loads prior artifacts unless `fresh`. State written for a different query is discarded:
   * its completed-window list means nothing for a different keyword.
   */
  static async open(
    cache: Cache,
    query: string,
    options: { fresh?: boolean; now?: Date } = {},
  ): Promise<DiscoveryStore> {
    const now = options.now ?? new Date();
    const stored = options.fresh
      ? null
      : await cache.getJSON<DiscoveryState>(discoveryKeys.state);
    const usable = stored !== null && stored.query === query ? stored : null;

    const entries = new Map<number, ListEntry>();
    const hashes = new Map<string, string>();

    if (usable !== null) {
      const listYaml = await cache.getText(discoveryKeys.fullList);
      const list = listYaml === null ? [] : ((parse(listYaml) as ListEntry[] | null) ?? []);
      for (const entry of list) entries.set(entry.id, entry);

      const stored_hashes =
        (await cache.getJSON<Record<string, string>>(discoveryKeys.hashes)) ?? {};
      for (const [repo, hash] of Object.entries(stored_hashes)) hashes.set(repo, hash);
    }

    const state: DiscoveryState = usable ?? {
      query,
      started_at: now.toISOString(),
      pending_windows: [],
      completed_windows: [],
      failed_windows: [],
      repos_seen: 0,
      requests: 0,
    };

    return new DiscoveryStore(cache, entries, hashes, state);
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
   * Writes all three shared artifacts. Called at window boundaries so a kill leaves the list,
   * the hashes and the resume point agreeing with each other.
   */
  async flush(): Promise<void> {
    this.state.repos_seen = this.entries.size;
    const list = [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path));
    await this.cache.putText(discoveryKeys.fullList, stringify(list), 'application/yaml');
    await this.cache.putJSON(discoveryKeys.hashes, Object.fromEntries(this.hashes));
    await this.cache.putJSON(discoveryKeys.state, this.state);
  }
}
