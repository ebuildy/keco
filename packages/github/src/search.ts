import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { backoffMs } from './quota';

/**
 * GitHub Search for the discovery worker (design 2026-08-02, revised 2026-08-04 after review).
 *
 * Search has its own budget — roughly 30 requests/minute authenticated — separate from the
 * 5000 points/hour REST budget that QuotaGovernor splits between crawler and analyzer
 * (AGENTS.md §4.2). So this client paces itself and deliberately does not touch the governor.
 *
 * The transport is injected rather than an Octokit instance being constructed inline, so the
 * whole retry, pacing and timeout story is testable without a network.
 */

/** Authenticated search allows ~30 req/min; one every two seconds stays under it. */
export const GITHUB_SEARCH_MIN_INTERVAL_MS = 2_000;

/** @octokit/request's fetch has no default timeout; a hung socket must not stall forever (§4.2). */
export const GITHUB_SEARCH_TIMEOUT_MS = 30_000;

/**
 * GitHub documents at least a 60s wait for a *secondary* rate limit, which is signalled by a
 * bare 403 with no `retry-after` at all. Retrying sooner is how a soft limit becomes a block.
 */
const THROTTLE_FLOOR_MS = 60_000;

/** A bogus `retry-after: 3600` (or a stale ratelimit-reset) must not sleep a silent hour. */
const THROTTLE_CEILING_MS = 300_000;

/** 403/429 mean "slow down"; these mean "the server had a bad moment, try again." */
const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504]);

/**
 * Only the fields discovery records. Validated at the boundary (§13) — GitHub returns ~80
 * more, most of them URL templates, and none of them belong in the detail document.
 *
 * These are required, not defaulted: CLAUDE.md §6 — "unknown is a real answer, absence of
 * evidence never becomes a positive claim." A guessed `default_branch` of 'main' silently
 * 404s every README image (§9); a guessed `false` for `archived` silently defeats the skip
 * rule (§4.1). GitHub's search endpoint always sends these; if that ever stops being true, a
 * loud parse failure is the correct signal, not a fabricated zero. `owner`, `description`,
 * `homepage`, `language`, `license` and `pushed_at` stay nullish — GitHub genuinely omits or
 * nulls those.
 */
export const SearchItem = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }).nullish(),
  description: z.string().nullish(),
  homepage: z.string().nullish(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  language: z.string().nullish(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
  topics: z.array(z.string()),
  archived: z.boolean(),
  fork: z.boolean(),
  default_branch: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  pushed_at: z.string().nullish(),
});
export type SearchItem = z.infer<typeof SearchItem>;

/**
 * Validates the page envelope only; `items` stays `unknown[]` here because one malformed
 * repo must cost one repo, not the other 99 good ones on the page — see `parsePage` below.
 */
const RawSearchPage = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(z.unknown()),
});

export type SearchPage = {
  total_count: number;
  incomplete_results: boolean;
  items: SearchItem[];
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The two halves of one clock, kept together — see `SearchClientOptions.clock`. */
export type Clock = {
  now(): number;
  sleep(ms: number): Promise<void>;
};

const defaultClock: Clock = { now: Date.now, sleep: realSleep };

export type SearchLogger = {
  warn(fields: object, message: string): void;
};

/**
 * A minimum-interval pacer. Steady spacing rather than bursts: GitHub's secondary rate
 * limits punish bursts even when the primary budget still has room.
 *
 * `wait()` chains onto a shared queue so concurrent callers are serialised rather than all
 * reading the same `nextAllowedAt` and firing together — the obvious next step for this
 * client is paging several windows in parallel, and that must not silently disable pacing.
 */
export class RatePacer {
  private nextAllowedAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: Clock = defaultClock,
  ) {}

  wait(): Promise<void> {
    this.queue = this.queue.then(() => this.waitTurn());
    return this.queue;
  }

  /**
   * Pushes the next allowed call out by `ms` from now, regardless of what was scheduled
   * before. Called on every throttle so a rate limit slows the whole client — every caller
   * sharing this pacer, not just the one request being retried.
   */
  penalise(ms: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, this.clock.now() + ms);
  }

  private async waitTurn(): Promise<void> {
    const delay = this.nextAllowedAt - this.clock.now();
    if (delay > 0) await this.clock.sleep(delay);
    this.nextAllowedAt = this.clock.now() + this.minIntervalMs;
  }
}

/** True for `{ status: number, ... }` shapes — what @octokit/request throws. Never throws itself. */
function httpStatus(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : undefined;
}

/** Reads `error.response.headers` defensively — same octokit error shape, one level deeper. */
function httpHeaders(error: unknown): Record<string, string> | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('headers' in response)) {
    return undefined;
  }
  const headers = response.headers;
  return typeof headers === 'object' && headers !== null
    ? (headers as Record<string, string>)
    : undefined;
}

export type SearchTransport = (params: {
  q: string;
  per_page: number;
  page: number;
}) => Promise<{ data: unknown; headers: Record<string, string | number | undefined> }>;

export type SearchClientOptions = {
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  clock?: Clock;
  logger?: SearchLogger;
};

export class SearchClient {
  private readonly pacer: RatePacer;
  private readonly maxRetries: number;
  private readonly clock: Clock;
  private readonly logger: SearchLogger | undefined;

  constructor(
    private readonly transport: SearchTransport,
    options: SearchClientOptions = {},
  ) {
    this.clock = options.clock ?? defaultClock;
    this.pacer = new RatePacer(options.minIntervalMs ?? GITHUB_SEARCH_MIN_INTERVAL_MS, this.clock);
    this.maxRetries = options.maxRetries ?? 5;
    this.logger = options.logger;
  }

  /** The only production construction path — real Octokit, capped by `timeoutMs`. */
  static fromToken(token: string, options: SearchClientOptions = {}): SearchClient {
    const octokit = new Octokit({ auth: token, userAgent: 'keco' });
    const timeoutMs = options.timeoutMs ?? GITHUB_SEARCH_TIMEOUT_MS;
    return new SearchClient(async (params) => {
      const response = await octokit.rest.search.repos({
        ...params,
        request: { signal: AbortSignal.timeout(timeoutMs) },
      });
      return { data: response.data, headers: response.headers };
    }, options);
  }

  /**
   * Fetches one page of a search query, paced and retried, and returns only the items that
   * validated. `page`/`perPage` are rejected up front when they'd land outside GitHub
   * Search's 1000-result cap — that call would 422 anyway, after spending a rate slot.
   */
  async page(query: string, page: number, perPage = 100): Promise<SearchPage> {
    if (perPage > 100) {
      throw new Error(`perPage must be <= 100 (GitHub search's own cap), got ${perPage}`);
    }
    if (page * perPage > 1000) {
      throw new Error(
        `page ${page} at perPage ${perPage} would exceed GitHub search's 1000-result cap`,
      );
    }

    for (let attempt = 0; ; attempt += 1) {
      await this.pacer.wait();
      let response: Awaited<ReturnType<SearchTransport>>;
      try {
        response = await this.transport({ q: query, per_page: perPage, page });
      } catch (error) {
        // Only transport failures are classified for retry here. `parsePage` below is
        // deliberately outside this try/catch: a schema failure means GitHub changed shape,
        // and retrying it would just burn the budget several times before failing anyway —
        // it must never be mistaken for a status-less transient network error.
        const status = httpStatus(error);
        const throttled = status === 403 || status === 429;
        const transient = status === undefined || TRANSIENT_STATUSES.has(status);

        if (throttled) {
          const waitMs = this.throttleWaitMs(error);
          this.pacer.penalise(waitMs);
          this.logger?.warn({ status, attempt, waitMs, query }, 'github search throttled');
        }

        if (attempt >= this.maxRetries || (!throttled && !transient)) throw error;

        if (throttled) continue; // the next pacer.wait() above enforces the penalty just set

        const waitMs = backoffMs(attempt, null);
        this.logger?.warn(
          { status, attempt, waitMs, query },
          'github search transient error, retrying',
        );
        await this.clock.sleep(waitMs);
        continue;
      }
      return this.parsePage(response.data, query);
    }
  }

  /** `retry-after` wins; else the absolute `x-ratelimit-reset`; else GitHub's documented floor. */
  private throttleWaitMs(error: unknown): number {
    const headers = httpHeaders(error);
    const retryAfter = Number(headers?.['retry-after'] ?? 0);
    if (retryAfter > 0) return Math.min(THROTTLE_CEILING_MS, retryAfter * 1000);

    const reset = Number(headers?.['x-ratelimit-reset'] ?? 0);
    if (reset > 0) {
      const delay = reset * 1000 - this.clock.now();
      if (delay > 0) return Math.min(THROTTLE_CEILING_MS, delay);
    }

    return THROTTLE_FLOOR_MS;
  }

  private parsePage(data: unknown, query: string): SearchPage {
    const raw = RawSearchPage.parse(data);
    const items: SearchItem[] = [];
    let dropped = 0;
    for (const candidate of raw.items) {
      const result = SearchItem.safeParse(candidate);
      if (result.success) items.push(result.data);
      else dropped += 1;
    }
    if (dropped > 0) {
      this.logger?.warn(
        { dropped, total: raw.items.length, query },
        'github search dropped malformed items',
      );
    }
    if (raw.incomplete_results) {
      this.logger?.warn({ query }, 'github search returned incomplete results');
    }
    return { total_count: raw.total_count, incomplete_results: raw.incomplete_results, items };
  }
}
