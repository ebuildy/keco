import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, FsStorage, discoveryKeys } from '@keco/cache';
import type { SearchItem } from '@keco/github';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscoveryStore, toDetail } from './store';

const item = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    id: 20038725,
    full_name: 'ahmetb/kubectx',
    name: 'kubectx',
    owner: { login: 'ahmetb' },
    description: 'Faster way to switch between clusters',
    homepage: 'https://kubectx.dev',
    stargazers_count: 18234,
    forks_count: 1180,
    open_issues_count: 41,
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
    topics: ['kubectl', 'kubernetes'],
    archived: false,
    fork: false,
    default_branch: 'master',
    created_at: '2014-05-22T12:00:00Z',
    updated_at: '2026-07-20T08:11:00Z',
    pushed_at: '2026-07-14T19:02:00Z',
    ...overrides,
  }) as SearchItem;

describe('toDetail', () => {
  it('flattens the search item into the documented shape', () => {
    const doc = toDetail(item(), 'kubernetes stars:>5000', '2026-08-02T09:30:00Z');

    expect(doc.owner).toBe('ahmetb');
    expect(doc.stars).toBe(18234);
    expect(doc.license).toBe('Apache-2.0');
    expect(doc.discovered_via).toBe('kubernetes stars:>5000');
    expect(doc.discovered_at).toBe('2026-08-02T09:30:00Z');
    expect(doc.payload_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('excludes discovered_at from the hash, or every file would look changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item(), 'q', '2026-09-14T22:00:00Z');
    expect(a.payload_hash).toBe(b.payload_hash);
  });

  it('changes the hash when the repo really changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item({ stargazers_count: 18999 }), 'q', '2026-08-02T09:30:00Z');
    expect(a.payload_hash).not.toBe(b.payload_hash);
  });

  it('sorts topics so their order cannot churn the hash', () => {
    const a = toDetail(item({ topics: ['a', 'b'] }), 'q', 'now');
    const b = toDetail(item({ topics: ['b', 'a'] }), 'q', 'now');
    expect(a.payload_hash).toBe(b.payload_hash);
  });
});

describe('DiscoveryStore', () => {
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keco-discovery-'));
    cache = new Cache(new FsStorage(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a detail document at its bucket path and reports it as new', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');

    expect(await store.record(item(), 'kubernetes stars:>5000')).toBe('new');

    const raw = await cache.getText(discoveryKeys.detail('ahmetb/kubectx'));
    expect(raw).not.toBeNull();
    expect(parse(raw!).full_name).toBe('ahmetb/kubectx');
  });

  it('skips the write when the payload is unchanged', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item(), 'q')).toBe('unchanged');
  });

  it('rewrites when the payload changed', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item({ stargazers_count: 19000 }), 'q')).toBe('changed');

    const raw = await cache.getText(discoveryKeys.detail('ahmetb/kubectx'));
    expect(parse(raw!).stars).toBe(19000);
  });

  it('writes the full list as id, path and name only, sorted by path', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item({ id: 2, full_name: 'zz/last', name: 'last' }), 'q');
    await store.record(item({ id: 1, full_name: 'aa/first', name: 'first' }), 'q');
    await store.flush();

    const list = parse((await cache.getText(discoveryKeys.fullList))!);
    expect(list).toEqual([
      { id: 1, path: 'aa/first', name: 'first' },
      { id: 2, path: 'zz/last', name: 'last' },
    ]);
  });

  it('deduplicates by repo id across windows, keeping the first sighting', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');

    expect(await store.record(item(), 'window-a')).toBe('new');
    // The same repo turning up in an overlapping window must not rewrite the document just
    // because discovered_via would differ — that would be a wasted write per duplicate.
    expect(await store.record(item(), 'window-b')).toBe('unchanged');
    await store.flush();

    expect(store.size).toBe(1);
    expect(parse((await cache.getText(discoveryKeys.fullList))!)).toHaveLength(1);

    const raw = await cache.getText(discoveryKeys.detail('ahmetb/kubectx'));
    expect(parse(raw!).discovered_via).toBe('window-a');
  });

  it('resumes the pending queue and completed windows', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    store.state.pending_windows = [{ base: 'kubernetes', stars: '0', created: null }];
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(resumed.state.pending_windows).toHaveLength(1);
    expect(resumed.state.completed_windows).toEqual(['kubernetes stars:>5000']);
  });

  it('ignores state written for a different query', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.record(item(), 'q');
    await store.flush();

    const other = await DiscoveryStore.open(cache, 'istio');
    expect(other.state.completed_windows).toEqual([]);
    expect(other.size).toBe(0);
  });

  it('starts over when opened fresh', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.flush();

    const fresh = await DiscoveryStore.open(cache, 'kubernetes', { fresh: true });
    expect(fresh.size).toBe(0);
    expect(fresh.state.completed_windows).toEqual([]);
  });

  it('rewrites a detail document whose entry is missing from the list', async () => {
    // Guards a torn flush: hashes landed, the list did not.
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();
    await cache.putText(discoveryKeys.fullList, '[]');

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item(), 'q')).toBe('new');
    expect(resumed.size).toBe(1);
  });
});
