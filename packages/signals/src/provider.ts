import { externalKey, isFresh, type Cache, type ExternalEnvelope } from '@keco/cache';
import type { z } from 'zod';

/**
 * Every external signal goes through here (AGENTS.md §4.2). A provider called without
 * the cache in front of it turns a replay into a 30k-request storm and gets the IP
 * throttled by Scorecard or Artifact Hub — that is the bug this module exists to prevent.
 *
 * Rules encoded below, all mandatory:
 *   - cache first, always; `forceRefresh` is the only bypass and it is a manual flag
 *   - hard timeout on every call
 *   - degrade, never fail: a dead provider yields null + an entry in partial_signals[]
 */
export type ProviderResult<T> = {
  value: T | null;
  fetched_at: string | null;
  /** True when the provider failed or timed out — the caller records it in partial_signals[]. */
  partial: boolean;
};

export type ProviderDefinition<T> = {
  name: string;
  /** Fixed TTL in seconds. Signal freshness drifts from repo freshness (§14). */
  ttlSeconds: number;
  timeoutMs: number;
  schema: z.ZodType<T>;
  /** Builds the request. Return null when this provider cannot answer for this key. */
  request: (key: string) => { url: string; init?: RequestInit } | null;
  /** Defaults to `response.json()`. Override for a non-JSON body (CNCF Landscape's YAML). */
  parseBody?: (response: Response) => Promise<unknown>;
};

export type FetchOptions = {
  forceRefresh?: boolean;
  now?: Date;
};

export class Provider<T> {
  constructor(
    private readonly definition: ProviderDefinition<T>,
    private readonly cache: Cache,
  ) {}

  get name(): string {
    return this.definition.name;
  }

  async fetch(key: string, options: FetchOptions = {}): Promise<ProviderResult<T>> {
    const now = options.now ?? new Date();
    const cacheKey = externalKey(this.definition.name, key);

    if (!options.forceRefresh) {
      const cached = await this.cache.getJSON<ExternalEnvelope<T>>(cacheKey);
      if (cached && isFresh(cached, now)) {
        return { value: cached.body, fetched_at: cached.fetched_at, partial: cached.status >= 400 };
      }
    }

    const request = this.definition.request(key);
    if (request === null) return { value: null, fetched_at: null, partial: true };

    const envelope = await this.perform(request, now);
    await this.cache.putJSON(cacheKey, envelope);
    return {
      value: envelope.body,
      fetched_at: envelope.fetched_at,
      partial: envelope.body === null,
    };
  }

  private async perform(
    request: { url: string; init?: RequestInit },
    now: Date,
  ): Promise<ExternalEnvelope<T>> {
    const base = {
      fetched_at: now.toISOString(),
      ttl_seconds: this.definition.ttlSeconds,
    };
    try {
      const response = await fetch(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(this.definition.timeoutMs),
      });
      if (!response.ok) return { ...base, status: response.status, body: null };
      const body = await (this.definition.parseBody ?? ((r: Response) => r.json()))(response);
      const parsed = this.definition.schema.safeParse(body);
      // A provider that changed its shape is a partial signal, not a crash.
      return { ...base, status: response.status, body: parsed.success ? parsed.data : null };
    } catch {
      // Timeout, DNS, TLS, rate-limit — all the same to the pipeline: unknown, move on.
      return { ...base, status: 0, body: null };
    }
  }
}

export const DAY = 86_400;
