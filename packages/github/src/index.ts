import { Octokit } from '@octokit/rest';
import { QuotaGovernor, type QuotaConsumer, backoffMs } from './quota';

export * from './quota';

/**
 * GitHub access for the write side only (AGENTS.md §7): the crawler and the analyzer.
 * apps/web must never import this package — the lint config enforces it.
 *
 * Everything fetched here is written to the cache verbatim by the caller. This client
 * transforms nothing.
 */
export type GitHubClientOptions = {
  token: string;
  consumer: QuotaConsumer;
  /** Share of the shared 5000 points/hour budget (GITHUB_QUOTA_*_SHARE). */
  quotaShare: number;
};

/** A conditional GET result: 304 costs no quota and short-circuits the pipeline (§4.1). */
export type Conditional<T> =
  | { status: 'modified'; body: T; etag: string | null }
  | { status: 'not-modified' }
  | { status: 'absent' };

export class GitHubClient {
  readonly quota: QuotaGovernor;
  private readonly rest: Octokit;

  constructor(options: GitHubClientOptions) {
    this.quota = new QuotaGovernor(options.consumer, options.quotaShare);
    this.rest = new Octokit({ auth: options.token, userAgent: 'keco' });
  }

  /**
   * Conditional REST request. Pass the ETag stored in `repos/{owner}/{repo}/_fetch.json`
   * and a 304 comes back free — which is what makes a weekly full sweep affordable.
   */
  async conditional<T>(
    route: string,
    params: Record<string, unknown>,
    etag: string | null,
  ): Promise<Conditional<T>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.rest.request(route, {
          ...params,
          headers: etag ? { 'if-none-match': etag } : undefined,
        });
        this.quota.observe({
          remaining: response.headers['x-ratelimit-remaining'],
          reset: response.headers['x-ratelimit-reset'],
        });
        return {
          status: 'modified',
          body: response.data as T,
          etag: (response.headers.etag as string | undefined) ?? null,
        };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 304) return { status: 'not-modified' };
        if (status === 404) return { status: 'absent' };
        if ((status === 403 || status === 429) && attempt < 5) {
          const retryAfter = Number(
            (error as { response?: { headers?: Record<string, string> } }).response?.headers?.[
              'retry-after'
            ] ?? 0,
          );
          await sleep(backoffMs(attempt, retryAfter || null));
          continue;
        }
        throw error;
      }
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic sharding (§4). Scale out by splitting the corpus, never by locks or
 * leases — there is no coordination primitive in this system and you must not invent one.
 */
export function ownsShard(repo: string, shardCount: number, shardIndex: number): boolean {
  if (shardCount <= 1) return true;
  let hash = 2166136261;
  for (let i = 0; i < repo.length; i += 1) {
    hash ^= repo.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % shardCount === shardIndex;
}
