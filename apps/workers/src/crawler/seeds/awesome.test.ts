import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Cache, type Storage } from '@keco/cache';
import { AWESOME_LISTS, awesomeSeed, reposFromMarkdown } from './awesome';

const README = readFileSync(join(import.meta.dirname, '__fixtures__/awesome-readme.md'), 'utf8');

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

describe('reposFromMarkdown', () => {
  it('extracts repos from markdown links and bare autolinks', () => {
    expect(reposFromMarkdown(README)).toEqual([
      'argoproj/argo-cd',
      'helm/helm',
      'kubernetes-sigs/kustomize',
    ]);
  });

  it('collapses a deep path to its repo and deduplicates', () => {
    expect(reposFromMarkdown(README).filter((r) => r === 'helm/helm')).toHaveLength(1);
  });

  it('drops the badge image target, non-GitHub hosts and reserved paths', () => {
    const repos = reposFromMarkdown(README);
    expect(repos).not.toContain('sindresorhus/awesome');
    expect(repos).not.toContain('example/thing');
    expect(repos.some((r) => r.startsWith('sponsors/'))).toBe(false);
  });

  it('ignores relative links', () => {
    expect(reposFromMarkdown('[x](CONTRIBUTING.md)')).toEqual([]);
  });

  it('handles empty input', () => {
    expect(reposFromMarkdown('')).toEqual([]);
  });

  it('excludes a badge link regardless of which URL is the image and which is the link target', () => {
    const reversed =
      '[![Awesome](https://github.com/sindresorhus/awesome)](https://img.shields.io/badge/awesome-yes-brightgreen)';
    expect(reposFromMarkdown(reversed)).toEqual([]);
  });
});

describe('AWESOME_LISTS', () => {
  it('declares every list explicitly, with a reason', () => {
    expect(AWESOME_LISTS.length).toBeGreaterThan(0);
    for (const list of AWESOME_LISTS) {
      expect(list.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(list.why.length).toBeGreaterThan(10);
    }
  });
});

describe('awesomeSeed', () => {
  it('fetches every declared list and merges their repos', async () => {
    const fetch = vi.fn(async () => new Response(README, { status: 200 }));
    const refs = await awesomeSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(AWESOME_LISTS.length);
    expect(refs).toContainEqual({ repo: 'argoproj/argo-cd', source: 'awesome' });
  });

  it('deduplicates across lists', async () => {
    const fetch = vi.fn(async () => new Response(README, { status: 200 }));
    const refs = await awesomeSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(new Set(refs.map((r) => r.repo)).size).toBe(refs.length);
  });

  it('keeps going when one list is unreachable', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response('', { status: 404 }) : new Response(README, { status: 200 });
    });
    const refs = await awesomeSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(refs.length).toBeGreaterThan(0);
  });

  it('yields nothing when every list is unreachable', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    const refs = await awesomeSeed.refs({
      cache: memoryCache(),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(refs).toEqual([]);
  });
});
