import { describe, expect, it, vi } from 'vitest';
import { Cache, type Storage } from '@keco/cache';
import { REPOS } from '../discovery/store/collections';
import { InMemoryDataStore } from '../lib/data-store.memory';
import { DISCOVERY_COLLECTIONS } from '../discovery/store/collections';
import { buildWorklist, isOrgRef } from './worklist';
import type { SeedAdapter } from './seeds';

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

const seedYielding = (name: string, repos: string[]): SeedAdapter => ({
  name,
  refs: async () => repos.map((repo) => ({ repo, source: name })),
});

async function discoveryStore(repos: { full_name: string; stars: number; owner?: string }[]) {
  const dataStore = new InMemoryDataStore();
  await dataStore.ensure(DISCOVERY_COLLECTIONS);
  await dataStore.put(
    REPOS,
    repos.map((r, i) => ({
      id: `kubernetes_${i}`,
      query_slug: 'kubernetes',
      full_name: r.full_name,
      stars: r.stars,
      owner: r.owner ?? r.full_name.split('/')[0],
    })),
  );
  return dataStore;
}

const deps = async (repos: { full_name: string; stars: number; owner?: string }[] = []) => ({
  dataStore: await discoveryStore(repos),
  cache: memoryCache(),
  fetch: vi.fn() as unknown as typeof globalThis.fetch,
});

const options = {
  repo: null,
  seeds: [] as SeedAdapter[],
  limit: 100,
  shardCount: 1,
  shardIndex: 0,
};

describe('isOrgRef', () => {
  it('is true for a bare org', () => {
    expect(isOrgRef('argoproj')).toBe(true);
  });

  it('is false for owner/name', () => {
    expect(isOrgRef('argoproj/argo-cd')).toBe(false);
  });
});

describe('buildWorklist', () => {
  it('returns just the named repo when --repo is given, ignoring every source', async () => {
    const d = await deps([{ full_name: 'o/from-discovery', stars: 10 }]);
    const result = await buildWorklist(
      { ...options, repo: 'argoproj/argo-cd', seeds: [seedYielding('cncf', ['helm/helm'])] },
      d,
    );
    expect(result).toEqual([{ repo: 'argoproj/argo-cd', source: 'cli' }]);
  });

  it('crawls seeds before the discovery corpus', async () => {
    const d = await deps([{ full_name: 'o/discovered', stars: 999 }]);
    const result = await buildWorklist({ ...options, seeds: [seedYielding('cncf', ['helm/helm'])] }, d);
    expect(result.map((w) => w.repo)).toEqual(['helm/helm', 'o/discovered']);
  });

  it('resolves seeds in the order given', async () => {
    const d = await deps();
    const result = await buildWorklist(
      { ...options, seeds: [seedYielding('krew', ['a/a']), seedYielding('cncf', ['b/b'])] },
      d,
    );
    expect(result.map((w) => w.repo)).toEqual(['a/a', 'b/b']);
  });

  it('takes the discovery corpus by stars descending, so --limit buys the best repos', async () => {
    const d = await deps([
      { full_name: 'o/small', stars: 1 },
      { full_name: 'o/huge', stars: 9000 },
      { full_name: 'o/medium', stars: 50 },
    ]);
    const result = await buildWorklist({ ...options, limit: 2 }, d);
    expect(result.map((w) => w.repo)).toEqual(['o/huge', 'o/medium']);
  });

  it('deduplicates across sources, first source winning', async () => {
    const d = await deps([{ full_name: 'helm/helm', stars: 100 }]);
    const result = await buildWorklist(
      { ...options, seeds: [seedYielding('cncf', ['helm/helm']), seedYielding('krew', ['helm/helm'])] },
      d,
    );
    expect(result).toEqual([{ repo: 'helm/helm', source: 'cncf' }]);
  });

  it('stops at the limit', async () => {
    const d = await deps();
    const result = await buildWorklist(
      { ...options, limit: 2, seeds: [seedYielding('cncf', ['a/a', 'b/b', 'c/c'])] },
      d,
    );
    expect(result).toHaveLength(2);
  });

  it('keeps only the repos this shard owns', async () => {
    const d = await deps();
    const all = ['a/a', 'b/b', 'c/c', 'd/d', 'e/e', 'f/f', 'g/g', 'h/h'];
    const shard0 = await buildWorklist(
      { ...options, shardCount: 2, shardIndex: 0, seeds: [seedYielding('cncf', all)] },
      await deps(),
    );
    const shard1 = await buildWorklist(
      { ...options, shardCount: 2, shardIndex: 1, seeds: [seedYielding('cncf', all)] },
      d,
    );
    // Deterministic sharding, never locks or leases (§4): every repo lands in exactly one.
    expect([...shard0, ...shard1].map((w) => w.repo).sort()).toEqual([...all].sort());
    expect(shard0.length + shard1.length).toBe(all.length);
  });

  it('reports a seed that yields nothing, and keeps going', async () => {
    const onSeedError = vi.fn();
    const d = await deps();
    const result = await buildWorklist(
      { ...options, seeds: [seedYielding('artifacthub', []), seedYielding('cncf', ['a/a'])] },
      { ...d, onSeedError },
    );
    // An outage that yields zero refs is otherwise indistinguishable from a quiet registry.
    expect(onSeedError).toHaveBeenCalledWith('artifacthub', expect.stringContaining('no refs'));
    expect(result.map((w) => w.repo)).toEqual(['a/a']);
  });

  it('reports a seed that throws, and keeps going', async () => {
    const onSeedError = vi.fn();
    const d = await deps();
    const exploding: SeedAdapter = { name: 'krew', refs: async () => { throw new Error('boom'); } };
    const result = await buildWorklist(
      { ...options, seeds: [exploding, seedYielding('cncf', ['a/a'])] },
      { ...d, onSeedError },
    );
    expect(onSeedError).toHaveBeenCalledWith('krew', 'boom');
    expect(result.map((w) => w.repo)).toEqual(['a/a']);
  });

  it('skips a discovery document with no usable full_name', async () => {
    const dataStore = new InMemoryDataStore();
    await dataStore.ensure(DISCOVERY_COLLECTIONS);
    await dataStore.put(REPOS, [{ id: 'kubernetes_1', query_slug: 'kubernetes', stars: 5 }]);
    const result = await buildWorklist(options, {
      dataStore,
      cache: memoryCache(),
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });
    expect(result).toEqual([]);
  });

  describe('--repo <org> (no slash)', () => {
    it('returns every repo discovered under that org, sorted by stars descending', async () => {
      const d = await deps([
        { full_name: 'argoproj/argo-cd', stars: 100, owner: 'argoproj' },
        { full_name: 'argoproj/argo-rollouts', stars: 900, owner: 'argoproj' },
        { full_name: 'helm/helm', stars: 5000, owner: 'helm' },
      ]);
      const result = await buildWorklist({ ...options, repo: 'argoproj' }, d);
      expect(result).toEqual([
        { repo: 'argoproj/argo-rollouts', source: 'cli' },
        { repo: 'argoproj/argo-cd', source: 'cli' },
      ]);
    });

    it('ignores seeds, --limit and sharding — an explicit org is explicit', async () => {
      const many = Array.from({ length: 20 }, (_, i) => ({
        full_name: `argoproj/repo-${i}`,
        stars: i,
        owner: 'argoproj',
      }));
      const d = await deps(many);
      const result = await buildWorklist(
        {
          ...options,
          repo: 'argoproj',
          limit: 2,
          shardCount: 4,
          shardIndex: 0,
          seeds: [seedYielding('cncf', ['helm/helm'])],
        },
        d,
      );
      expect(result).toHaveLength(20);
      expect(result.every((w) => w.repo.startsWith('argoproj/'))).toBe(true);
    });

    it('does not call any seed adapter in org mode', async () => {
      const refs = vi.fn(async () => []);
      const d = await deps([{ full_name: 'argoproj/argo-cd', stars: 1, owner: 'argoproj' }]);
      await buildWorklist({ ...options, repo: 'argoproj', seeds: [{ name: 'cncf', refs }] }, d);
      expect(refs).not.toHaveBeenCalled();
    });

    it('returns [] for an org nothing has been discovered under yet', async () => {
      const d = await deps([{ full_name: 'helm/helm', stars: 1, owner: 'helm' }]);
      const result = await buildWorklist({ ...options, repo: 'unknown-org' }, d);
      expect(result).toEqual([]);
    });

    it('matches the owner exactly, not as a prefix', async () => {
      const d = await deps([{ full_name: 'argoproj-extras/thing', stars: 1, owner: 'argoproj-extras' }]);
      const result = await buildWorklist({ ...options, repo: 'argoproj' }, d);
      expect(result).toEqual([]);
    });
  });

  describe('provisioning discovery_repos before reading it', () => {
    // A crawler run can be the first thing to touch a fresh Meilisearch host, and is always
    // the first thing to run after a filterable attribute (like `owner`) is added to
    // collections.ts and no discovery sweep has re-synced settings yet. Real Meilisearch
    // rejects a `where` filter on an attribute its settings don't declare filterable — an
    // in-memory store can't reproduce that error, so this pins the contract that would have
    // prevented it instead: every path that reads `discovery_repos` provisions it first.

    it('ensures DISCOVERY_COLLECTIONS before reading the corpus in batch mode', async () => {
      const d = await deps([{ full_name: 'o/discovered', stars: 1 }]);
      const ensureSpy = vi.spyOn(d.dataStore, 'ensure');
      await buildWorklist(options, d);
      expect(ensureSpy).toHaveBeenCalledWith(DISCOVERY_COLLECTIONS);
    });

    it('ensures DISCOVERY_COLLECTIONS before reading the corpus in org mode', async () => {
      const d = await deps([{ full_name: 'argoproj/argo-cd', stars: 1, owner: 'argoproj' }]);
      const ensureSpy = vi.spyOn(d.dataStore, 'ensure');
      await buildWorklist({ ...options, repo: 'argoproj' }, d);
      expect(ensureSpy).toHaveBeenCalledWith(DISCOVERY_COLLECTIONS);
    });

    it('never touches the data store for an explicit owner/name --repo', async () => {
      // Not even ensure(): a single named repo is a pure CLI echo (§ "explicit is explicit"),
      // and provisioning a collection this path never reads would be a silent extra network
      // round-trip to Meilisearch on every single-repo crawl.
      const dataStore = new InMemoryDataStore(); // deliberately never ensure()d
      const ensureSpy = vi.spyOn(dataStore, 'ensure');
      const listSpy = vi.spyOn(dataStore, 'list');
      const result = await buildWorklist(
        { ...options, repo: 'argoproj/argo-cd' },
        { dataStore, cache: memoryCache(), fetch: vi.fn() as unknown as typeof globalThis.fetch },
      );
      expect(result).toEqual([{ repo: 'argoproj/argo-cd', source: 'cli' }]);
      expect(ensureSpy).not.toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalled();
    });
  });
});
