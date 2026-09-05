import { describe, expect, it, vi } from 'vitest';
import { Cache, type Storage, externalKey } from '@keco/cache';
import { externalGet, DAY_SECONDS } from './external';

/** An in-memory Storage. The fs adapter is tested in packages/cache; this needs a Map. */
function memoryStorage(): Storage {
  const files = new Map<string, Buffer>();
  return {
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => void files.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body)),
    has: async (key) => files.has(key),
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
    delete: async (key) => void files.delete(key),
  };
}

const response = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });

describe('externalGet', () => {
  const options = { provider: 'demo', key: 'index', url: 'https://example.test/i', ttlSeconds: DAY_SECONDS };

  it('fetches, envelopes and caches on a miss', async () => {
    const cache = new Cache(memoryStorage());
    const fetch = vi.fn(async () => response('hello'));
    const now = new Date('2026-09-05T00:00:00.000Z');

    const result = await externalGet(options, { cache, fetch, now: () => now });

    expect(result).toEqual({ body: 'hello', status: 200, fetched_at: now.toISOString(), cached: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await cache.getJSON(externalKey('demo', 'index'))).toEqual({
      fetched_at: now.toISOString(),
      ttl_seconds: DAY_SECONDS,
      status: 200,
      body: 'hello',
    });
  });

  it('serves a fresh envelope without touching the network', async () => {
    const cache = new Cache(memoryStorage());
    const fetch = vi.fn(async () => response('hello'));
    const t0 = new Date('2026-09-05T00:00:00.000Z');
    await externalGet(options, { cache, fetch, now: () => t0 });

    const t1 = new Date('2026-09-05T06:00:00.000Z');
    const result = await externalGet(options, { cache, fetch, now: () => t1 });

    expect(result).toEqual({ body: 'hello', status: 200, fetched_at: t0.toISOString(), cached: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has expired', async () => {
    const cache = new Cache(memoryStorage());
    const fetch = vi.fn(async () => response('hello'));
    await externalGet(options, { cache, fetch, now: () => new Date('2026-09-05T00:00:00.000Z') });
    await externalGet(options, { cache, fetch, now: () => new Date('2026-09-07T00:00:00.000Z') });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses a fresh envelope', async () => {
    const cache = new Cache(memoryStorage());
    const fetch = vi.fn(async () => response('hello'));
    const now = () => new Date('2026-09-05T00:00:00.000Z');
    await externalGet(options, { cache, fetch, now });
    await externalGet({ ...options, forceRefresh: true }, { cache, fetch, now });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('degrades to a null body on an error status, and caches the failure', async () => {
    const cache = new Cache(memoryStorage());
    const fetch = vi.fn(async () => response('nope', 503));
    const result = await externalGet(options, { cache, fetch, now: () => new Date() });
    expect(result.body).toBeNull();
    expect(result.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('degrades to a null body when fetch throws', async () => {
    const cache = new Cache(memoryStorage());
    const fetch = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const result = await externalGet(options, { cache, fetch, now: () => new Date() });
    expect(result).toMatchObject({ body: null, status: 0 });
  });

  it('does not serve a cached failure past its TTL floor', async () => {
    const cache = new Cache(memoryStorage());
    let status = 503;
    const fetch = vi.fn(async () => response('body', status));
    await externalGet(options, { cache, fetch, now: () => new Date('2026-09-05T00:00:00.000Z') });
    status = 200;
    // A failure is cached for FAILURE_TTL_SECONDS, not the full TTL: a dead provider must
    // recover within minutes, not a day.
    const result = await externalGet(options, { cache, fetch, now: () => new Date('2026-09-05T00:10:00.000Z') });
    expect(result.body).toBe('body');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
