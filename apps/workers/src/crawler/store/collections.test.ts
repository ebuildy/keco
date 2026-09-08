import { describe, expect, it } from 'vitest';
import { DOCUMENT_ID_PATTERN } from '../../lib/data-store';
import { CRAWL_COLLECTIONS, CRAWL_HISTORY, emptyCounters, toCrawlRunDocument } from './collections';

const input = {
  runId: '01K4ABCDEFGHJKMNPQRSTVWXYZ',
  startedAt: new Date('2026-09-05T10:00:00.000Z'),
  limit: 200,
  repo: null,
  shardCount: 1,
  shardIndex: 0,
  outcome: 'running' as const,
};

describe('CRAWL_COLLECTIONS', () => {
  it('declares crawl_history as a plain key-value store', () => {
    const spec = CRAWL_COLLECTIONS.find((c) => c.name === CRAWL_HISTORY);
    expect(spec).toBeDefined();
    // searchableAttributes: [] makes it a key-value store, not a read model (AGENTS.md §5).
    expect(spec?.searchable).toEqual([]);
    expect(spec?.primaryKey).toBe('run_id');
  });

  it('declares every field the history command sorts and filters on', () => {
    const spec = CRAWL_COLLECTIONS.find((c) => c.name === CRAWL_HISTORY)!;
    expect(spec.sortable).toContain('started_at');
    expect(spec.sortable).toContain('duration_ms');
    expect(spec.sortable).toContain('repos_fetched');
    expect(spec.filterable).toContain('outcome');
  });
});

describe('toCrawlRunDocument', () => {
  it('produces a portable document id', () => {
    const doc = toCrawlRunDocument(input);
    expect(DOCUMENT_ID_PATTERN.test(String(doc.run_id))).toBe(true);
  });

  it('leaves a running run with no ending', () => {
    const doc = toCrawlRunDocument(input);
    expect(doc).toMatchObject({ outcome: 'running', finished_at: null, duration_ms: null });
  });

  it('stamps duration when the run ends', () => {
    const doc = toCrawlRunDocument({
      ...input,
      outcome: 'complete',
      endedAt: new Date('2026-09-05T10:02:30.000Z'),
    });
    expect(doc).toMatchObject({ outcome: 'complete', finished_at: '2026-09-05T10:02:30.000Z', duration_ms: 150_000 });
  });

  it('defaults every counter to zero rather than undefined', () => {
    const doc = toCrawlRunDocument(input);
    for (const field of Object.keys(emptyCounters())) {
      expect(doc[field]).toBe(0);
    }
  });

  it('carries counters through', () => {
    const doc = toCrawlRunDocument({
      ...input,
      counters: { ...emptyCounters(), repos_fetched: 12, requests: 40, points_spent: 37 },
    });
    expect(doc).toMatchObject({ repos_fetched: 12, requests: 40, points_spent: 37 });
  });

  it('records the run configuration so a short run explains itself', () => {
    const doc = toCrawlRunDocument({ ...input, repo: 'argoproj/argo-cd', shardCount: 4, shardIndex: 2 });
    expect(doc).toMatchObject({ limit: 200, repo: 'argoproj/argo-cd', shard_count: 4, shard_index: 2 });
  });
});
