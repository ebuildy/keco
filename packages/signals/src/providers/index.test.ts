import { Cache, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeOsvKey, osvProvider } from './index';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('osvProvider', () => {
  it('queries OSV with both the ecosystem and the name', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response(JSON.stringify({ vulns: [{ id: 'GHSA-1' }] }), { status: 200 });
      }),
    );

    const cache = new Cache(memoryStorage());
    const result = await osvProvider(cache).fetch(encodeOsvKey('Go', 'sigs.k8s.io/controller-runtime'));

    expect(result.value?.vulns).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      package: { name: 'sigs.k8s.io/controller-runtime', ecosystem: 'Go' },
    });
  });

  it('degrades without a network call when the key has no ecosystem', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const cache = new Cache(memoryStorage());

    const result = await osvProvider(cache).fetch('not-a-valid-key');

    expect(result).toEqual({ value: null, fetched_at: null, partial: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
