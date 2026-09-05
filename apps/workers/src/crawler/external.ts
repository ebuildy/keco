import { externalKey, isFresh, type Cache, type ExternalEnvelope } from '@keco/cache';

/**
 * Every third-party response the crawler fetches, cached with a TTL (AGENTS.md §4.2). A seed
 * called without this in front of it turns a re-crawl into a request storm against
 * Artifact Hub, and a parser fix into a re-download of a 1.5 MB landscape file.
 *
 * This duplicates `Provider` in @keco/signals by design: §7 reserves that package for the
 * analyzer, and widening a boundary that exists to keep uncached third-party calls out of the
 * pipeline is a worse trade than the 40 lines below. See the design spec §7.4.
 *
 * The body is stored as **text**, not parsed JSON: seeds consume YAML as often as JSON, and
 * parsing on write would mean a parser bug could only be fixed by re-downloading — exactly the
 * property §3's "verbatim means verbatim" exists to protect.
 */

export const DAY_SECONDS = 86_400;

/**
 * A failed fetch is cached, but only briefly. Caching it for the full TTL would take a
 * provider down for a day over one 503; not caching it at all would hammer a provider that is
 * already struggling, once per repo.
 */
export const FAILURE_TTL_SECONDS = 300;

/** Bounds one seed's wait. A slow registry must not stall a crawl of 30k repos. */
const DEFAULT_TIMEOUT_MS = 30_000;

export type ExternalGetOptions = {
  provider: string;
  /** Distinguishes documents within a provider — becomes part of the cache key. */
  key: string;
  url: string;
  ttlSeconds: number;
  timeoutMs?: number;
  init?: RequestInit;
  /** The only TTL bypass, and it is manual (§4.2). */
  forceRefresh?: boolean;
};

export type ExternalDeps = {
  cache: Cache;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
};

export type ExternalResult = {
  /** `null` means the provider failed. Degrade, never fail (§4.2). */
  body: string | null;
  status: number;
  fetched_at: string;
  cached: boolean;
};

export async function externalGet(
  options: ExternalGetOptions,
  deps: ExternalDeps,
): Promise<ExternalResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cacheKey = externalKey(options.provider, options.key);

  if (options.forceRefresh !== true) {
    const cached = await deps.cache.getJSON<ExternalEnvelope<string>>(cacheKey);
    if (cached !== null && isFresh(cached, now)) {
      return {
        body: cached.body,
        status: cached.status,
        fetched_at: cached.fetched_at,
        cached: true,
      };
    }
  }

  const envelope = await perform(options, deps, now);
  await deps.cache.putJSON(cacheKey, envelope);
  return {
    body: envelope.body,
    status: envelope.status,
    fetched_at: envelope.fetched_at,
    cached: false,
  };
}

async function perform(
  options: ExternalGetOptions,
  deps: ExternalDeps,
  now: Date,
): Promise<ExternalEnvelope<string>> {
  const fetched_at = now.toISOString();
  try {
    const response = await deps.fetch(options.url, {
      ...options.init,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { fetched_at, ttl_seconds: FAILURE_TTL_SECONDS, status: response.status, body: null };
    }
    return {
      fetched_at,
      ttl_seconds: options.ttlSeconds,
      status: response.status,
      body: await response.text(),
    };
  } catch {
    // Timeout, DNS, TLS, connection reset — all the same to the pipeline: unknown, move on.
    return { fetched_at, ttl_seconds: FAILURE_TTL_SECONDS, status: 0, body: null };
  }
}
