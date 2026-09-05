import type { Cache } from '@keco/cache';

/**
 * What every seed adapter is (AGENTS.md §4.2). Split out from `index.ts` so an adapter can
 * import the type without importing the registry that imports it back.
 *
 * A seed answers *which* repos to crawl. `seeds/github/` answers *what is in one* — a
 * different job under the same directory, and deliberately not a `SeedAdapter`.
 */
export type SeedRef = {
  /** `owner/repo`. */
  repo: string;
  /** Recorded in `_fetch.json.source` and in the RepoDiscovered-shaped provenance. */
  source: string;
};

export type SeedContext = {
  cache: Cache;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
  /** The only TTL bypass, and it is manual (§4.2). */
  forceRefresh?: boolean;
  /** For the one seed that reads a GitHub API endpoint; unauthenticated is 60 req/hour. */
  githubToken?: string;
};

export type SeedAdapter = {
  name: string;
  /**
   * Never throws for an upstream failure — a dead provider yields `[]` and the crawl carries
   * on (§4.2, "degrade, never fail"). The caller records the shortfall on the run document.
   */
  refs(context: SeedContext): Promise<SeedRef[]>;
};
