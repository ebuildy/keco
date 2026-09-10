import { Cache, Journal, repoKeys, type Storage } from '@keco/cache';
import type { Event } from '@keco/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAnalyzer } from './index';

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

function repoJson(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'kubectx',
    description: 'Switch faster between clusters and namespaces',
    topics: ['kubernetes-operator'],
    language: 'Go',
    archived: false,
    created_at: '2016-01-01T00:00:00.000Z',
    pushed_at: '2026-07-01T00:00:00.000Z',
    license: { spdx_id: 'Apache-2.0' },
    owner: { login: 'ahmetb', type: 'User' },
    ...overrides,
  };
}

async function seedRepo(
  cache: Cache,
  repo: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const keys = repoKeys(repo);
  await cache.putJSON(keys.repo, repoJson(overrides));
  await cache.putText(keys.readme, '# kubectx');
  await cache.putJSON(keys.tree, { tree: [{ path: 'main.go', type: 'blob' }] });
}

/** Every event ever appended, oldest first — for assertions independent of checkpoint state. */
async function allEvents(journal: Journal): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of journal.read({ afterId: null })) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runAnalyzer (default, journal-driven path)', () => {
  it('analyzes every changed RepoFetched event and advances the checkpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'ahmetb/kubectx');
    await journal.append({
      type: 'RepoFetched',
      repo: 'ahmetb/kubectx',
      content_hash: 'hash-1',
      changed: true,
    });
    await journal.append({
      type: 'RepoFetched',
      repo: 'ahmetb/kubectx',
      content_hash: 'hash-1',
      changed: false,
    });

    await runAnalyzer(
      { forceRefresh: null, repo: null, minConfidence: null },
      { cache, journal, llm: null },
    );

    const analysis = await cache.getJSON<{ repo: string; content_hash: string }>(
      'analysis/ahmetb/kubectx.json',
    );
    expect(analysis?.repo).toBe('ahmetb/kubectx');
    expect(analysis?.content_hash).toBe('hash-1');

    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).not.toBeNull();

    // A second run with nothing new to see must not re-analyze — the checkpoint already
    // covers both events above.
    await cache.delete('analysis/ahmetb/kubectx.json');
    await runAnalyzer(
      { forceRefresh: null, repo: null, minConfidence: null },
      { cache, journal, llm: null },
    );
    expect(await cache.has('analysis/ahmetb/kubectx.json')).toBe(false);
  });

  it('analyzes two distinct repos discovered in the same batch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'ahmetb/kubectx');
    await seedRepo(cache, 'derailed/k9s', {
      name: 'k9s',
      owner: { login: 'derailed', type: 'User' },
    });
    await journal.append({
      type: 'RepoFetched',
      repo: 'ahmetb/kubectx',
      content_hash: 'hash-1',
      changed: true,
    });
    await journal.append({
      type: 'RepoFetched',
      repo: 'derailed/k9s',
      content_hash: 'hash-2',
      changed: true,
    });

    await runAnalyzer(
      { forceRefresh: null, repo: null, minConfidence: null },
      { cache, journal, llm: null },
    );

    expect(await cache.has('analysis/ahmetb/kubectx.json')).toBe(true);
    expect(await cache.has('analysis/derailed/k9s.json')).toBe(true);

    const analyzed = (await allEvents(journal)).filter((event) => event.type === 'RepoAnalyzed');
    expect(analyzed.map((event) => event.repo).sort()).toEqual(['ahmetb/kubectx', 'derailed/k9s']);
  });

  it('appends RepoSkipped and keeps going when repo.json is missing from the cache', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    // No seedRepo() call — the analyzer has nothing to read for this one.
    await journal.append({
      type: 'RepoFetched',
      repo: 'ghost/repo',
      content_hash: 'hash-2',
      changed: true,
    });

    await runAnalyzer(
      { forceRefresh: null, repo: null, minConfidence: null },
      { cache, journal, llm: null },
    );

    expect(await cache.has('analysis/ghost/repo.json')).toBe(false);
    const skipped = (await allEvents(journal)).find(
      (event) => event.type === 'RepoSkipped' && event.repo === 'ghost/repo',
    );
    expect(skipped).toMatchObject({
      type: 'RepoSkipped',
      repo: 'ghost/repo',
      reason: 'not-crawled',
    });

    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).not.toBeNull(); // still advances — a broken repo must not block the corpus
  });

  it('records RepoFailed and keeps going when a cached artifact is corrupt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    const keys = repoKeys('broken/repo');
    // Malformed JSON at the repo.json key: cache.getJSON throws SyntaxError parsing it, which
    // is the real path `analyzeRepo`'s dependency chain can throw through — not the controlled
    // null-return of a never-crawled repo.
    await cache.putText(keys.repo, 'not valid json {');
    await journal.append({
      type: 'RepoFetched',
      repo: 'broken/repo',
      content_hash: 'hash-3',
      changed: true,
    });

    await runAnalyzer(
      { forceRefresh: null, repo: null, minConfidence: null },
      { cache, journal, llm: null },
    );

    expect(await cache.has('analysis/broken/repo.json')).toBe(false);
    const failed = (await allEvents(journal)).find(
      (event) => event.type === 'RepoFailed' && event.repo === 'broken/repo',
    );
    expect(failed).toMatchObject({ type: 'RepoFailed', repo: 'broken/repo', phase: 'analyze' });

    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).not.toBeNull(); // still advances — a broken repo must not block the corpus
  });
});

describe('runAnalyzer (--repo bypass)', () => {
  it('analyzes exactly the named repo without touching the checkpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'ahmetb/kubectx');
    await cache.putJSON(repoKeys('ahmetb/kubectx').fetch, {
      etags: { repo: null, readme: null, tree: null, releases: null },
      fetched_at: '2026-08-01T00:00:00.000Z',
      content_hash: 'hash-direct',
      source: 'cli',
      manifests: [],
    });
    // A second, unrelated repo with a pending journal event — must be left untouched.
    await journal.append({
      type: 'RepoFetched',
      repo: 'other/repo',
      content_hash: 'hash-x',
      changed: true,
    });

    await runAnalyzer(
      { forceRefresh: null, repo: 'ahmetb/kubectx', minConfidence: null },
      { cache, journal, llm: null },
    );

    const analysis = await cache.getJSON<{ content_hash: string }>('analysis/ahmetb/kubectx.json');
    expect(analysis?.content_hash).toBe('hash-direct');
    expect(await cache.has('analysis/other/repo.json')).toBe(false);

    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).toBeNull();
  });

  it('exits with an error when the named repo has never been crawled', async () => {
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    process.exitCode = undefined;

    await runAnalyzer(
      { forceRefresh: null, repo: 'never/crawled', minConfidence: null },
      { cache, journal, llm: null },
    );

    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
