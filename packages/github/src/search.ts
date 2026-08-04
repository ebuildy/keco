import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { backoffMs } from './quota';

/**
 * GitHub Search for the discovery worker (design 2026-08-02).
 *
 * Search has its own budget — roughly 30 requests/minute authenticated — separate from the
 * 5000 points/hour REST budget that QuotaGovernor splits between crawler and analyzer
 * (AGENTS.md §4.2). So this client paces itself and deliberately does not touch the governor.
 *
 * The transport is injected rather than an Octokit instance being constructed inline, so the
 * whole retry and pacing story is testable without a network.
 */

/** Authenticated search allows ~30 req/min; one every two seconds stays under it. */
export const GITHUB_SEARCH_MIN_INTERVAL_MS = 2_000;

/**
 * Only the fields discovery records. Validated at the boundary (§13) — GitHub returns ~80
 * more, most of them URL templates, and none of them belong in the detail document.
 */
export const SearchItem = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }).nullish(),
  description: z.string().nullish(),
  homepage: z.string().nullish(),
  stargazers_count: z.number().default(0),
  forks_count: z.number().default(0),
  open_issues_count: z.number().default(0),
  language: z.string().nullish(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
  topics: z.array(z.string()).default([]),
  archived: z.boolean().default(false),
  fork: z.boolean().default(false),
  default_branch: z.string().default('main'),
  created_at: z.string(),
  updated_at: z.string(),
  pushed_at: z.string().nullish(),
});
export type SearchItem = z.infer<typeof SearchItem>;

export const SearchPage = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean().default(false),
  items: z.array(SearchItem),
});
export type SearchPage = z.infer<typeof SearchPage>;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimum-interval pacer. Steady spacing rather than bursts: GitHub's secondary rate
 * limits punish bursts even when the primary budget still has room.
 */
export class RatePacer {
  private nextAllowedAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  async wait(): Promise<void> {
    const delay = this.nextAllowedAt - this.now();
    if (delay > 0) await this.sleep(delay);
    this.nextAllowedAt = this.now() + this.minIntervalMs;
  }
}

export type SearchTransport = (params: {
  q: string;
  per_page: number;
  page: number;
}) => Promise<unknown>;

export type SearchClientOptions = {
  minIntervalMs?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class SearchClient {
  private readonly pacer: RatePacer;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly transport: SearchTransport,
    options: SearchClientOptions = {},
  ) {
    const now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.pacer = new RatePacer(
      options.minIntervalMs ?? GITHUB_SEARCH_MIN_INTERVAL_MS,
      now,
      this.sleep,
    );
    this.maxRetries = options.maxRetries ?? 5;
  }

  static fromToken(token: string, options: SearchClientOptions = {}): SearchClient {
    const octokit = new Octokit({ auth: token, userAgent: 'keco' });
    return new SearchClient(
      async (params) => (await octokit.rest.search.repos(params)).data,
      options,
    );
  }

  /**
   * One page of results. Page 1 is also the probe: its `total_count` is what decides
   * whether the window needs subdividing, and its items are real results either way.
   */
  async page(query: string, page: number, perPage = 100): Promise<SearchPage> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pacer.wait();
      try {
        return SearchPage.parse(await this.transport({ q: query, per_page: perPage, page }));
      } catch (error) {
        // Only throttling is retried. A schema failure means GitHub changed shape, and
        // retrying it would just burn the budget five times before failing anyway.
        const status = (error as { status?: number }).status;
        if ((status === 403 || status === 429) && attempt < this.maxRetries) {
          const retryAfter = Number(
            (error as { response?: { headers?: Record<string, string> } }).response?.headers?.[
              'retry-after'
            ] ?? 0,
          );
          await this.sleep(backoffMs(attempt, retryAfter || null));
          continue;
        }
        throw error;
      }
    }
  }
}
