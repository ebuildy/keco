import { Cache, Journal, repoKeys, type Storage } from '@keco/cache';
import type { Analysis, Event } from '@keco/core';
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

/**
 * A schema-valid `analysis/**` document — every field `AnalysisSchema` requires, so the
 * `--min-confidence` sweep's `AnalysisSchema.safeParse` accepts it. Mirrors the fixture in
 * `packages/core/src/schemas.test.ts`.
 */
function analysisDoc(overrides: Partial<Analysis> = {}): Analysis {
  return {
    repo: 'ahmetb/kubectx',
    content_hash: 'hash-1',
    summary: 'Switch faster between clusters and namespaces.',
    kind: 'cli',
    domains: ['dev-experience'],
    runtime: 'workstation',
    license_class: 'unknown',
    openness: 'unknown',
    maturity: 'unknown',
    governance: 'unknown',
    k8s_relevance: 0.9,
    confidence: 0.5,
    needs_review: false,
    install_methods: [],
    signals: { scorecard: null, osv: null, dependents: null },
    method: 'rules',
    model: null,
    signals_used: [],
    partial_signals: [],
    analyzed_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
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

  it('records RepoFailed instead of crashing when the named repo has a corrupted _fetch.json', async () => {
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    // Malformed JSON at the _fetch.json key: cache.getJSON throws parsing it, which is the real
    // path a corrupted cache entry can throw through — not the controlled null-return of a
    // never-crawled repo.
    await cache.putText(repoKeys('broken/repo').fetch, 'not valid json {');

    await runAnalyzer(
      { forceRefresh: null, repo: 'broken/repo', minConfidence: null },
      { cache, journal, llm: null },
    );

    expect(await cache.has('analysis/broken/repo.json')).toBe(false);
    const failed = (await allEvents(journal)).find(
      (event) => event.type === 'RepoFailed' && event.repo === 'broken/repo',
    );
    expect(failed).toMatchObject({ type: 'RepoFailed', repo: 'broken/repo', phase: 'analyze' });

    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).toBeNull(); // the bypass never touches the checkpoint
  });
});

describe('runAnalyzer (--min-confidence sweep)', () => {
  it('re-analyzes only the existing analyses below the threshold', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'ahmetb/kubectx');
    await seedRepo(cache, 'other/confident-repo');

    await cache.putJSON(
      'analysis/ahmetb/kubectx.json',
      analysisDoc({ repo: 'ahmetb/kubectx', content_hash: 'hash-1', confidence: 0.3 }),
    );
    const seededConfident = analysisDoc({
      repo: 'other/confident-repo',
      content_hash: 'hash-2',
      confidence: 0.95,
    });
    await cache.putJSON('analysis/other/confident-repo.json', seededConfident);

    await runAnalyzer(
      { forceRefresh: null, repo: null, minConfidence: 0.7 },
      { cache, journal, llm: null },
    );

    const reanalyzed = await cache.getJSON<{ analyzed_at: string }>('analysis/ahmetb/kubectx.json');
    expect(reanalyzed?.analyzed_at).toBeDefined();

    // Untouched: byte-for-byte the document this test seeded — nothing analyzeRepo would add.
    const untouched = await cache.getJSON<Analysis>('analysis/other/confident-repo.json');
    expect(untouched).toEqual(seededConfident);
  });

  it('records a failure and keeps sweeping past a corrupted analysis file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'zzz-valid/repo');

    // `cache.list('analysis/')` returns keys in lexicographic order, so a corrupted entry that
    // sorts before a valid one proves the sweep survives it rather than crashing before ever
    // reaching the rest of the corpus (§13: a single bad repo must never abort a run).
    await cache.putText('analysis/aaa-corrupt/repo.json', 'not valid json {');
    await cache.putJSON(
      'analysis/zzz-valid/repo.json',
      analysisDoc({ repo: 'zzz-valid/repo', content_hash: 'hash-1', confidence: 0.2 }),
    );

    await runAnalyzer(
      { forceRefresh: null, repo: null, minConfidence: 0.7 },
      { cache, journal, llm: null },
    );

    const reanalyzed = await cache.getJSON<{ analyzed_at: string }>('analysis/zzz-valid/repo.json');
    expect(reanalyzed?.analyzed_at).toBeDefined();

    // The corrupted entry's own `repo` field is untrustworthy, so the failure is attributed to
    // the repo named by the cache key path itself (`analysis/aaa-corrupt/repo.json` → the repo
    // `aaa-corrupt/repo`), not to anything the corrupted content claims.
    const failed = (await allEvents(journal)).find(
      (event) => event.type === 'RepoFailed' && event.repo === 'aaa-corrupt/repo',
    );
    expect(failed).toMatchObject({
      type: 'RepoFailed',
      repo: 'aaa-corrupt/repo',
      phase: 'analyze',
    });
  });
});
