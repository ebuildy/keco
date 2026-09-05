// apps/workers/src/crawler/seeds/github/fetch.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Cache, repoKeys, type Storage } from '@keco/cache';
import type { NewEvent } from '@keco/core';
import type { Conditional } from '@keco/github';
import { fetchRepo, REFRESH_AFTER_DAYS, type FetchMeta } from './fetch';

function memoryStorage(): { storage: Storage; files: Map<string, Buffer>; order: string[] } {
  const files = new Map<string, Buffer>();
  const order: string[] = [];
  return {
    files,
    order,
    storage: {
      get: async (key) => files.get(key) ?? null,
      put: async (key, body) => {
        order.push(key);
        files.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
      },
      has: async (key) => files.has(key),
      list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
      delete: async (key) => void files.delete(key),
    },
  };
}

const REPO_JSON = {
  owner: { login: 'argoproj', avatar_url: 'https://avatars.test/u/1' },
  name: 'argo-cd',
  full_name: 'argoproj/argo-cd',
  description: 'GitOps CD',
  homepage: 'https://argo-cd.readthedocs.io',
  topics: ['kubernetes', 'gitops'],
  archived: false,
  fork: false,
  stargazers_count: 17_000,
  pushed_at: '2026-09-01T00:00:00.000Z',
  default_branch: 'master',
  license: { spdx_id: 'Apache-2.0' },
};

const README_JSON = {
  path: 'README.md',
  encoding: 'base64',
  content: Buffer.from('# Argo CD\n').toString('base64'),
};

const TREE_JSON = {
  truncated: false,
  tree: [
    { path: 'go.mod', type: 'blob' },
    { path: 'main.go', type: 'blob' },
    { path: 'cmd', type: 'tree' },
  ],
};

const RELEASES_JSON = [{ tag_name: 'v2.11.0' }];

/** A conditional client that answers by route, recording what it was asked. */
function fakeClient(
  answers: Record<string, { status: 'modified' | 'not-modified' | 'absent'; body?: unknown; etag?: string | null }>,
) {
  const calls: { route: string; etag: string | null }[] = [];
  return {
    calls,
    client: {
      // Explicitly generic — a plain inferred arrow function here would type as
      // `Conditional<unknown>`, which `ConditionalClient`'s `conditional<T>(...)` cannot accept
      // for an arbitrary caller-supplied `T`. The cast on `body` is the fake's only concession:
      // the fixtures above already match the shape each call site expects.
      conditional: async <T>(
        route: string,
        _params: Record<string, unknown>,
        etag: string | null,
      ): Promise<Conditional<T>> => {
        calls.push({ route, etag });
        const answer = answers[route] ?? { status: 'absent' as const };
        if (answer.status === 'modified') {
          return { status: 'modified' as const, body: answer.body as T, etag: answer.etag ?? null };
        }
        return { status: answer.status } as { status: 'not-modified' | 'absent' };
      },
    },
  };
}

const ALL_MODIFIED = {
  'GET /repos/{owner}/{repo}': { status: 'modified' as const, body: REPO_JSON, etag: 'repo-1' },
  'GET /repos/{owner}/{repo}/readme': { status: 'modified' as const, body: README_JSON, etag: 'readme-1' },
  'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': { status: 'modified' as const, body: TREE_JSON, etag: 'tree-1' },
  'GET /repos/{owner}/{repo}/releases': { status: 'modified' as const, body: RELEASES_JSON, etag: 'rel-1' },
};

function deps(overrides: Record<string, unknown> = {}) {
  const { storage, files, order } = memoryStorage();
  const events: NewEvent[] = [];
  const raw = vi.fn(async (url: string | URL) =>
    String(url).endsWith('go.mod')
      ? new Response('module github.com/argoproj/argo-cd\n', { status: 200, headers: { 'content-type': 'text/plain' } })
      : new Response('', { status: 404 }),
  );
  return {
    files,
    order,
    events,
    raw,
    deps: {
      cache: new Cache(storage),
      journal: { append: async (event: NewEvent) => void events.push(event) },
      fetch: raw as unknown as typeof globalThis.fetch,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      ...overrides,
    },
  };
}

describe('fetchRepo', () => {
  it('writes every artifact §3 names, then the event, then _fetch.json', async () => {
    const { deps: d, files, order, events } = deps();
    const { client } = fakeClient(ALL_MODIFIED);

    const result = await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });

    expect(result.type).toBe('fetched');
    const keys = repoKeys('argoproj/argo-cd');
    expect(files.has(keys.repo)).toBe(true);
    expect(files.has(keys.readme)).toBe(true);
    expect(files.has(keys.readmeMeta)).toBe(true);
    expect(files.has(keys.tree)).toBe(true);
    expect(files.has(keys.releases)).toBe(true);
    expect(files.has(keys.manifest('go.mod'))).toBe(true);

    // The ordering invariant: _fetch.json is written LAST, after the journal event. A crash
    // between them re-crawls and re-emits, which is free. The reverse loses the event silently
    // and the analyzer never learns the repo exists.
    expect(order.at(-1)).toBe(keys.fetch);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'RepoFetched', repo: 'argoproj/argo-cd', changed: true });
  });

  it('stores repo.json verbatim', async () => {
    const { deps: d, files } = deps();
    const { client } = fakeClient(ALL_MODIFIED);
    await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });
    expect(JSON.parse(files.get(repoKeys('argoproj/argo-cd').repo)!.toString('utf8'))).toEqual(REPO_JSON);
  });

  it('records the etags and source in _fetch.json', async () => {
    const { deps: d, files } = deps();
    const { client } = fakeClient(ALL_MODIFIED);
    await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });
    const meta = JSON.parse(files.get(repoKeys('argoproj/argo-cd').fetch)!.toString('utf8')) as FetchMeta;
    expect(meta.etags).toEqual({ repo: 'repo-1', readme: 'readme-1', tree: 'tree-1', releases: 'rel-1' });
    expect(meta.source).toBe('cncf');
    expect(meta.manifests).toEqual(['go.mod']);
  });

  it('short-circuits on a 304 without touching README, tree or releases', async () => {
    const { deps: d, events } = deps();
    const previous: FetchMeta = {
      etags: { repo: 'repo-1', readme: 'readme-1', tree: 'tree-1', releases: 'rel-1' },
      fetched_at: '2026-09-04T00:00:00.000Z',
      content_hash: 'cafebabe',
      source: 'cncf',
      manifests: ['go.mod'],
    };
    await d.cache.putJSON(repoKeys('argoproj/argo-cd').fetch, previous);
    const { client, calls } = fakeClient({
      'GET /repos/{owner}/{repo}': { status: 'not-modified' },
    });

    const result = await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ type: 'fetched', changed: false, content_hash: 'cafebabe', points: 0 });
    expect(events[0]).toMatchObject({ type: 'RepoFetched', changed: false });
  });

  it('sends the stored repo etag on a conditional request', async () => {
    const { deps: d } = deps();
    await d.cache.putJSON(repoKeys('o/r').fetch, {
      etags: { repo: 'repo-1', readme: null, tree: null, releases: null },
      fetched_at: '2026-09-04T00:00:00.000Z',
      content_hash: 'x',
      source: 'cncf',
      manifests: [],
    } satisfies FetchMeta);
    const { client, calls } = fakeClient({ 'GET /repos/{owner}/{repo}': { status: 'not-modified' } });
    await fetchRepo('o/r', 'cncf', { ...d, client });
    expect(calls[0]?.etag).toBe('repo-1');
  });

  it('ignores a stored etag older than the refresh window', async () => {
    const { deps: d } = deps();
    const old = new Date('2026-09-05T00:00:00.000Z');
    old.setUTCDate(old.getUTCDate() - REFRESH_AFTER_DAYS - 1);
    await d.cache.putJSON(repoKeys('o/r').fetch, {
      etags: { repo: 'repo-1', readme: null, tree: null, releases: null },
      fetched_at: old.toISOString(),
      content_hash: 'x',
      source: 'cncf',
      manifests: [],
    } satisfies FetchMeta);
    const { client, calls } = fakeClient(ALL_MODIFIED);
    await fetchRepo('o/r', 'cncf', { ...d, client });
    // The 304 short-circuit assumes GitHub's repo etag covers pushed_at. If that is ever
    // wrong, a stale entry must self-heal rather than going permanently stale.
    expect(calls[0]?.etag).toBeNull();
  });

  it('emits RepoSkipped for a 404 and writes nothing', async () => {
    const { deps: d, files, events } = deps();
    const { client } = fakeClient({ 'GET /repos/{owner}/{repo}': { status: 'absent' } });
    const result = await fetchRepo('o/gone', 'cncf', { ...d, client });
    expect(result).toMatchObject({ type: 'skipped', reason: 'not-found' });
    expect(events[0]).toMatchObject({ type: 'RepoSkipped', reason: 'not-found' });
    expect(files.size).toBe(0);
  });

  it('emits RepoSkipped for a low-star fork before spending the other three requests', async () => {
    const { deps: d, events } = deps();
    const { client, calls } = fakeClient({
      ...ALL_MODIFIED,
      'GET /repos/{owner}/{repo}': {
        status: 'modified',
        body: { ...REPO_JSON, fork: true, stargazers_count: 3 },
        etag: 'repo-1',
      },
    });
    const result = await fetchRepo('o/r', 'cncf', { ...d, client });
    expect(result).toMatchObject({ type: 'skipped', reason: 'fork' });
    expect(calls).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'RepoSkipped', reason: 'fork' });
  });

  it('reports changed:false when the content hash is unchanged', async () => {
    const { deps: d } = deps();
    const { client } = fakeClient(ALL_MODIFIED);
    const first = await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });
    // Same payloads, no stored etag match (the fake ignores etags) — so everything refetches
    // and the hash must come out identical.
    const second = await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });
    expect(first).toMatchObject({ changed: true });
    expect(second).toMatchObject({ changed: false, content_hash: (first as { content_hash: string }).content_hash });
  });

  it('survives a repo with no README', async () => {
    const { deps: d, files } = deps();
    const { client } = fakeClient({ ...ALL_MODIFIED, 'GET /repos/{owner}/{repo}/readme': { status: 'absent' } });
    const result = await fetchRepo('o/r', 'cncf', { ...d, client });
    expect(result.type).toBe('fetched');
    expect(files.has(repoKeys('o/r').readme)).toBe(false);
  });

  it('counts a 304 as a request but not as a spent point', async () => {
    const { deps: d } = deps();
    await d.cache.putJSON(repoKeys('o/r').fetch, {
      etags: { repo: 'repo-1', readme: null, tree: null, releases: null },
      fetched_at: '2026-09-04T00:00:00.000Z',
      content_hash: 'x',
      source: 'cncf',
      manifests: [],
    } satisfies FetchMeta);
    const { client } = fakeClient({ 'GET /repos/{owner}/{repo}': { status: 'not-modified' } });
    const result = await fetchRepo('o/r', 'cncf', { ...d, client });
    expect(result).toMatchObject({ requests: 1, points: 0 });
  });

  it('does not spend a point on a raw.githubusercontent manifest fetch', async () => {
    const { deps: d } = deps();
    const { client } = fakeClient(ALL_MODIFIED);
    const result = await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });
    // 4 API calls spend 4 points; the go.mod fetch adds a request but no point.
    expect(result).toMatchObject({ points: 4, requests: 5 });
  });

  it('does not record a manifest path whose fetch 404s or exceeds the size cap', async () => {
    const { deps: d, files } = deps({
      fetch: vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('go.mod')) return new Response('', { status: 404 });
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    });
    const { client } = fakeClient(ALL_MODIFIED);
    const result = await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });
    expect(result).toMatchObject({ type: 'fetched', requests: 5 });
    expect(files.has(repoKeys('argoproj/argo-cd').manifest('go.mod'))).toBe(false);
    const meta = JSON.parse(files.get(repoKeys('argoproj/argo-cd').fetch)!.toString('utf8')) as FetchMeta;
    expect(meta.manifests).toEqual([]);
  });

  it('calls updateIcon and reports whether one landed', async () => {
    const { deps: d } = deps({
      fetch: vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('go.mod')) {
          return new Response('module x\n', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    });
    const { client } = fakeClient(ALL_MODIFIED);
    const result = await fetchRepo('argoproj/argo-cd', 'cncf', { ...d, client });
    // No fetchable logo in this fixture, so the icon is absent — and the crawl carries on.
    expect(result).toMatchObject({ type: 'fetched', icon_updated: false });
  });
});
