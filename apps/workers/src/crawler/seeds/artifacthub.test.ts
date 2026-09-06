import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Cache, type Storage } from '@keco/cache';
import {
  ARTIFACTHUB_PAGE_SIZE,
  MAX_PAGES,
  artifactHubSeed,
  operatorHubSeed,
  parseArtifactHubPage,
} from './artifacthub';

const PAGE = readFileSync(join(import.meta.dirname, '__fixtures__/artifacthub-page.json'), 'utf8');

function memoryCache(): Cache {
  const files = new Map<string, Buffer>();
  const storage: Storage = {
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => void files.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body)),
    has: async (key) => files.has(key),
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
    delete: async (key) => void files.delete(key),
  };
  return new Cache(storage);
}

describe('parseArtifactHubPage', () => {
  it('extracts GitHub repository URLs', () => {
    expect(parseArtifactHubPage(PAGE)).toEqual([
      'argoproj/argo-helm',
      'cert-manager/cert-manager',
      'argoproj/argo-helm',
    ]);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseArtifactHubPage('{oops')).toEqual([]);
  });

  it('returns [] when packages is missing or the wrong shape', () => {
    expect(parseArtifactHubPage('{}')).toEqual([]);
    expect(parseArtifactHubPage('{"packages":"nope"}')).toEqual([]);
  });
});

describe('artifactHubSeed', () => {
  it('pages until a short page and deduplicates', async () => {
    const fetch = vi.fn(async (url: string | URL) =>
      String(url).includes('offset=0')
        ? new Response(PAGE, { status: 200 })
        : new Response('{"packages":[]}', { status: 200 }),
    );

    const refs = await artifactHubSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(refs).toEqual([
      { repo: 'argoproj/argo-helm', source: 'artifacthub' },
      { repo: 'cert-manager/cert-manager', source: 'artifacthub' },
    ]);
    // Page 1 was short (5 < ARTIFACTHUB_PAGE_SIZE), so there is no page 2.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requests the helm chart kind', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(PAGE, { status: 200 }));
    await artifactHubSeed.refs({ cache: memoryCache(), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('kind=0');
  });

  it('stops at MAX_PAGES even when every page is full', async () => {
    const full = JSON.stringify({
      packages: Array.from({ length: ARTIFACTHUB_PAGE_SIZE }, (_, i) => ({
        repository: { url: `https://github.com/o/r${i}` },
      })),
    });
    const fetch = vi.fn(async () => new Response(full, { status: 200 }));
    await artifactHubSeed.refs({ cache: memoryCache(), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(fetch).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it('stops paging when a page fails, keeping what it already has', async () => {
    const full = JSON.stringify({
      packages: Array.from({ length: ARTIFACTHUB_PAGE_SIZE }, (_, i) => ({
        repository: { url: `https://github.com/o/r${i}` },
      })),
    });
    const fetch = vi.fn(async (url: string | URL) =>
      String(url).includes('offset=0') ? new Response(full, { status: 200 }) : new Response('', { status: 503 }),
    );
    const refs = await artifactHubSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(refs).toHaveLength(ARTIFACTHUB_PAGE_SIZE);
  });

  it('yields nothing when the very first page fails', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    const refs = await artifactHubSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(refs).toEqual([]);
  });
});

describe('operatorHubSeed', () => {
  it('is the same adapter against the OLM operator kind', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(PAGE, { status: 200 }));
    const refs = await operatorHubSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain('kind=3');
    expect(refs[0]).toEqual({ repo: 'argoproj/argo-helm', source: 'operatorhub' });
  });

  it('caches under its own provider so it does not collide with artifacthub', async () => {
    const cache = memoryCache();
    const fetch = vi.fn(async () => new Response(PAGE, { status: 200 }));
    const context = { cache, fetch: fetch as unknown as typeof globalThis.fetch };
    await artifactHubSeed.refs(context);
    await operatorHubSeed.refs(context);
    // Two providers, two cache entries — a shared key would serve helm charts as operators.
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
