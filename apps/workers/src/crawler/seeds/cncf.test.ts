// apps/workers/src/crawler/seeds/cncf.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Cache, type Storage } from '@keco/cache';
import { cncfSeed, parseLandscape, LANDSCAPE_URL } from './cncf';

const FIXTURE = readFileSync(join(import.meta.dirname, '__fixtures__/cncf-landscape.yml'), 'utf8');

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

describe('parseLandscape', () => {
  it('walks categories and subcategories to every item', () => {
    const entries = parseLandscape(FIXTURE);
    expect(entries.map((e) => e.repo)).toEqual([
      'helm/helm',
      'kubevela/kubevela',
      'example/vendor-thing',
      'argoproj/argo-cd',
      'prometheus/prometheus',
    ]);
  });

  it('carries the CNCF maturity level, which the analyzer needs for maturity and governance', () => {
    const entries = parseLandscape(FIXTURE);
    expect(entries.find((e) => e.repo === 'helm/helm')).toMatchObject({ project: 'graduated' });
    expect(entries.find((e) => e.repo === 'kubevela/kubevela')).toMatchObject({ project: 'incubating' });
  });

  it('reports a non-CNCF landscape member with a null maturity, not a guess', () => {
    expect(parseLandscape(FIXTURE).find((e) => e.repo === 'example/vendor-thing')).toMatchObject({
      project: null,
    });
  });

  it('drops non-GitHub repos and items with no repo at all', () => {
    const repos = parseLandscape(FIXTURE).map((e) => e.repo);
    expect(repos).not.toContain('example/thing');
    expect(repos).toHaveLength(5);
  });

  it('deduplicates a repo listed under two categories, first wins', () => {
    expect(parseLandscape(FIXTURE).filter((e) => e.repo === 'prometheus/prometheus')).toHaveLength(1);
  });

  it('returns [] rather than throwing on malformed YAML', () => {
    expect(parseLandscape('landscape: [oops')).toEqual([]);
  });

  it('returns [] on YAML of an unexpected shape', () => {
    expect(parseLandscape('landscape: "a string"')).toEqual([]);
    expect(parseLandscape('other: 1')).toEqual([]);
  });
});

describe('cncfSeed', () => {
  it('fetches the landscape once and yields refs', async () => {
    const fetch = vi.fn(async (..._args: unknown[]) => new Response(FIXTURE, { status: 200 }));
    const cache = memoryCache();

    const refs = await cncfSeed.refs({ cache, fetch: fetch as unknown as typeof globalThis.fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(LANDSCAPE_URL);
    expect(refs).toContainEqual({ repo: 'helm/helm', source: 'cncf' });
    expect(refs).toHaveLength(5);
  });

  it('serves the second call from the cache without touching the network', async () => {
    const fetch = vi.fn(async () => new Response(FIXTURE, { status: 200 }));
    const cache = memoryCache();
    const context = { cache, fetch: fetch as unknown as typeof globalThis.fetch };

    await cncfSeed.refs(context);
    const second = await cncfSeed.refs(context);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(5);
  });

  it('yields nothing and does not throw when the provider is down', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    const refs = await cncfSeed.refs({ cache: memoryCache(), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(refs).toEqual([]);
  });

  it('yields nothing when fetch throws', async () => {
    const fetch = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    const refs = await cncfSeed.refs({ cache: memoryCache(), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(refs).toEqual([]);
  });
});
