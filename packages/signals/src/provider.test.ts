import { Cache, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DAY, Provider } from './provider';

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

describe('Provider parseBody', () => {
  it('uses a custom body parser instead of .json() when one is supplied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('name: value', { status: 200 })),
    );
    const cache = new Cache(memoryStorage());
    const provider = new Provider(
      {
        name: 'yaml-test',
        ttlSeconds: DAY,
        timeoutMs: 1_000,
        schema: z.object({ name: z.string() }),
        request: () => ({ url: 'https://example.test/thing.yaml' }),
        parseBody: async (response) => {
          const text = await response.text();
          const [, value] = text.split(': ');
          return { name: value };
        },
      },
      cache,
    );

    const result = await provider.fetch('all');

    expect(result.value).toEqual({ name: 'value' });
  });
});
