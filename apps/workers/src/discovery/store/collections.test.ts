import type { SearchItem } from '@keco/github';
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_COLLECTIONS,
  REPOS,
  RUNS,
  STATE,
  repoDocumentId,
  slugifyQuery,
  toDetail,
  toRepoDocument,
  toRunDocument,
  toStateDocument,
} from './collections';

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

describe('slugifyQuery', () => {
  it('lowercases and collapses runs of non-alphanumerics to one hyphen', () => {
    expect(slugifyQuery('Kubernetes  Operator!')).toBe('kubernetes-operator');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugifyQuery('  kubernetes  ')).toBe('kubernetes');
  });

  it('refuses a query with no ASCII alphanumerics rather than sweeping into a nameless slug', () => {
    expect(() => slugifyQuery('日本語')).toThrow(/no ASCII alphanumeric/);
  });

  it('produces a slug that is a legal document id, so ids built from it cannot be rejected', () => {
    expect(slugifyQuery('kubernetes operator')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('repoDocumentId', () => {
  it('joins slug and numeric id with an underscore, never a colon', () => {
    // A colon is the obvious separator and Meilisearch rejects it as a primary key.
    expect(repoDocumentId('kubernetes', 20038725)).toBe('kubernetes_20038725');
  });

  it('cannot collide across queries, because repo ids are numeric', () => {
    expect(repoDocumentId('a-b', 1)).not.toBe(repoDocumentId('a', 1));
  });
});

describe('DISCOVERY_COLLECTIONS', () => {
  it('declares all three collections', () => {
    expect(DISCOVERY_COLLECTIONS.map((c) => c.name)).toEqual([REPOS, RUNS, STATE]);
  });

  it('makes runs and state plain key-value collections', () => {
    // AGENTS.md §5: searchable: [] is what keeps them out of the inverted index.
    for (const name of [RUNS, STATE]) {
      const spec = DISCOVERY_COLLECTIONS.find((c) => c.name === name)!;
      expect(spec.searchable ?? []).toEqual([]);
    }
  });

  it('makes every field a mapper filters or sorts on declared on the spec', () => {
    const repos = DISCOVERY_COLLECTIONS.find((c) => c.name === REPOS)!;
    expect(repos.filterable).toContain('query_slug');
    const runs = DISCOVERY_COLLECTIONS.find((c) => c.name === RUNS)!;
    expect(runs.filterable).toContain('query_slug');
    expect(runs.sortable).toContain('started_at');
  });
});

describe('toDetail', () => {
  it('flattens the search item into the documented shape', () => {
    const doc = toDetail(item(), 'kubernetes stars:>5000', '2026-08-02T09:30:00Z');
    expect(doc.owner).toBe('ahmetb');
    expect(doc.stars).toBe(18234);
    expect(doc.license).toBe('Apache-2.0');
    expect(doc.discovered_via).toBe('kubernetes stars:>5000');
    expect(doc.payload_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('excludes discovered_at from the hash, or every document would look changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item(), 'q', '2026-08-03T11:00:00Z');
    expect(a.payload_hash).toBe(b.payload_hash);
  });

  it('excludes discovered_via from the hash, so a subdivided window does not rewrite', () => {
    const a = toDetail(item(), 'kubernetes', '2026-08-02T09:30:00Z');
    const b = toDetail(item(), 'kubernetes created:2020..2021', '2026-08-02T09:30:00Z');
    expect(a.payload_hash).toBe(b.payload_hash);
  });

  it('includes stars, because the document asserts the star count', () => {
    const a = toDetail(item(), 'q', 'now');
    const b = toDetail(item({ stargazers_count: 99 }), 'q', 'now');
    expect(a.payload_hash).not.toBe(b.payload_hash);
  });
});

describe('toRepoDocument', () => {
  it('carries the query, slug and provenance run ids', () => {
    const detail = toDetail(item(), 'kubernetes', '2026-08-02T09:30:00Z');
    const doc = toRepoDocument(detail, {
      query: 'kubernetes',
      querySlug: 'kubernetes',
      runId: '01J0RUN2',
      firstSeenRunId: '01J0RUN1',
    });
    expect(doc.id).toBe('kubernetes_20038725');
    expect(doc.repo_id).toBe(20038725);
    expect(doc.query_slug).toBe('kubernetes');
    expect(doc.first_seen_run_id).toBe('01J0RUN1');
    expect(doc.last_seen_run_id).toBe('01J0RUN2');
  });

  it('keeps the GitHub id under repo_id, since id is now the composite key', () => {
    const detail = toDetail(item(), 'kubernetes', 'now');
    const doc = toRepoDocument(detail, {
      query: 'kubernetes',
      querySlug: 'kubernetes',
      runId: 'r',
      firstSeenRunId: 'r',
    });
    expect(doc.id).not.toBe(20038725);
    expect(doc.repo_id).toBe(20038725);
  });
});

describe('toStateDocument', () => {
  it('deep-copies the live arrays, so later mutation cannot reach the document', () => {
    // runDiscovery aliases state.pending_windows as its work queue and keeps mutating it.
    // The DataStore copies too, but doing it here as well means the document handed to the
    // store is already a snapshot — belt and braces on the one bug that loses windows.
    const pending = [{ base: 'kubernetes', stars: '>100', created: null }];
    const doc = toStateDocument(
      {
        query: 'kubernetes',
        started_at: 'now',
        pending_windows: pending,
        completed_windows: ['a'],
        failed_windows: [],
        repos_seen: 1,
        pages_fetched: 2,
        dropped: 0,
      },
      { querySlug: 'kubernetes', runId: 'r', now: new Date('2026-08-29T00:00:00Z') },
    );
    pending.push({ base: 'MUTATED', stars: '', created: null });
    expect(doc.pending_windows).toHaveLength(1);
  });

  it('keys on the slug, one document per query', () => {
    const doc = toStateDocument(
      {
        query: 'kubernetes',
        started_at: 'now',
        pending_windows: [],
        completed_windows: [],
        failed_windows: [],
        repos_seen: 0,
        pages_fetched: 0,
        dropped: 0,
      },
      { querySlug: 'kubernetes', runId: 'r', now: new Date('2026-08-29T00:00:00Z') },
    );
    expect(doc.query_slug).toBe('kubernetes');
    expect(doc.updated_at).toBe('2026-08-29T00:00:00.000Z');
  });
});

describe('toRunDocument', () => {
  const base = {
    runId: '01J0RUN',
    query: 'kubernetes',
    querySlug: 'kubernetes',
    startedAt: new Date('2026-08-29T03:00:00Z'),
    fresh: false,
    limit: null,
  };

  it('marks a freshly opened run as running, with no end', () => {
    const doc = toRunDocument({ ...base, outcome: 'running' });
    expect(doc.run_id).toBe('01J0RUN');
    expect(doc.outcome).toBe('running');
    expect(doc.ended_at).toBeNull();
    expect(doc.duration_ms).toBeNull();
  });

  it('computes duration from started_at and endedAt', () => {
    const doc = toRunDocument({
      ...base,
      outcome: 'complete',
      endedAt: new Date('2026-08-29T04:12:00Z'),
      counts: { new: 1204, changed: 8891, unchanged: 40 },
      pagesFetched: 742,
      dropped: 3,
      windowsCompleted: 318,
      windowsFailed: 0,
      sweepReposTotal: 31204,
      sweepWindowsPending: 0,
      stoppedAtLimit: false,
      failedWindows: [],
    });
    expect(doc.duration_ms).toBe(72 * 60 * 1000);
    expect(doc.repos_new).toBe(1204);
    expect(doc.pages_fetched).toBe(742);
  });

  it('caps failed_windows, so one catastrophic sweep cannot write an unbounded document', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ window: `w${i}`, error: 'boom' }));
    const doc = toRunDocument({
      ...base,
      outcome: 'failed',
      endedAt: new Date('2026-08-29T03:01:00Z'),
      counts: { new: 0, changed: 0, unchanged: 0 },
      pagesFetched: 1,
      dropped: 0,
      windowsCompleted: 0,
      windowsFailed: 120,
      sweepReposTotal: 0,
      sweepWindowsPending: 0,
      stoppedAtLimit: false,
      failedWindows: many,
    });
    expect(doc.failed_windows).toHaveLength(50);
    expect(doc.windows_failed).toBe(120);
  });
});
