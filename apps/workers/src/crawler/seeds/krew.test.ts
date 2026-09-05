import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Cache, type Storage } from '@keco/cache';
import { krewSeed, parseKrewPlugin, pluginPaths } from './krew';

const dir = join(import.meta.dirname, '__fixtures__');
const TREE = readFileSync(join(dir, 'krew-tree.json'), 'utf8');
const PLUGIN = readFileSync(join(dir, 'krew-plugin.yaml'), 'utf8');

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

/** Answers the tree call from the fixture and every plugin YAML by name. */
function routedFetch(plugins: Record<string, string | number>) {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/git/trees/')) return new Response(TREE, { status: 200 });
    const name = target.slice(target.lastIndexOf('/') + 1);
    const answer = plugins[name];
    if (typeof answer === 'number') return new Response('', { status: answer });
    if (answer === undefined) return new Response('', { status: 404 });
    return new Response(answer, { status: 200 });
  });
}

describe('pluginPaths', () => {
  it('takes only top-level plugin YAML blobs', () => {
    expect(pluginPaths(TREE)).toEqual([
      'plugins/access-matrix.yaml',
      'plugins/ctx.yaml',
      'plugins/broken.yaml',
      'plugins/not-github.yaml',
    ]);
  });

  it('returns [] on malformed JSON', () => {
    expect(pluginPaths('{oops')).toEqual([]);
  });

  it('returns [] when the tree key is missing', () => {
    expect(pluginPaths('{"sha":"x"}')).toEqual([]);
  });
});

describe('parseKrewPlugin', () => {
  it('reads spec.homepage', () => {
    expect(parseKrewPlugin(PLUGIN)).toBe('https://github.com/corneliusweig/rakkess');
  });

  it('returns null when there is no homepage', () => {
    expect(parseKrewPlugin('apiVersion: v1\nkind: Plugin\nspec:\n  version: v1\n')).toBeNull();
  });

  it('returns null rather than throwing on malformed YAML', () => {
    expect(parseKrewPlugin('spec: [oops')).toBeNull();
  });
});

describe('krewSeed', () => {
  const context = () => ({ cache: memoryCache(), githubToken: 'tok' });

  it('yields one ref per plugin whose homepage is a GitHub repo', async () => {
    const fetch = routedFetch({
      'access-matrix.yaml': PLUGIN,
      'ctx.yaml': PLUGIN.replace('corneliusweig/rakkess', 'ahmetb/kubectx'),
      'broken.yaml': 'spec: [oops',
      'not-github.yaml': PLUGIN.replace('https://github.com/corneliusweig/rakkess', 'https://k8s.io/x'),
    });

    const refs = await krewSeed.refs({ ...context(), fetch: fetch as unknown as typeof globalThis.fetch });

    expect(refs).toEqual([
      { repo: 'corneliusweig/rakkess', source: 'krew' },
      { repo: 'ahmetb/kubectx', source: 'krew' },
    ]);
  });

  it('sends the GitHub token on the tree call, since unauthenticated is 60 req/hour', async () => {
    const fetch = routedFetch({ 'access-matrix.yaml': PLUGIN });
    await krewSeed.refs({ ...context(), fetch: fetch as unknown as typeof globalThis.fetch });
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer tok');
  });

  it('skips a plugin whose YAML 404s without failing the seed', async () => {
    const fetch = routedFetch({ 'access-matrix.yaml': PLUGIN, 'ctx.yaml': 404 });
    const refs = await krewSeed.refs({ ...context(), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(refs).toEqual([{ repo: 'corneliusweig/rakkess', source: 'krew' }]);
  });

  it('yields nothing when the index itself is unreachable', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    const refs = await krewSeed.refs({ ...context(), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(refs).toEqual([]);
  });

  it('deduplicates two plugins pointing at the same repo', async () => {
    const fetch = routedFetch({ 'access-matrix.yaml': PLUGIN, 'ctx.yaml': PLUGIN });
    const refs = await krewSeed.refs({ ...context(), fetch: fetch as unknown as typeof globalThis.fetch });
    expect(refs).toEqual([{ repo: 'corneliusweig/rakkess', source: 'krew' }]);
  });

  it('caches, so a second run touches the network not at all', async () => {
    const fetch = routedFetch({ 'access-matrix.yaml': PLUGIN, 'ctx.yaml': PLUGIN });
    const shared = { cache: memoryCache(), githubToken: 'tok', fetch: fetch as unknown as typeof globalThis.fetch };
    await krewSeed.refs(shared);
    const calls = fetch.mock.calls.length;
    await krewSeed.refs(shared);
    expect(fetch.mock.calls.length).toBe(calls);
  });
});
