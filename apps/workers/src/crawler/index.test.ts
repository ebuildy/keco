import { describe, expect, it, vi } from 'vitest';
import { crawl, type CrawlDeps } from './index';
import { emptyCounters } from './store/collections';
import type { WorkItem } from './worklist';

const items: WorkItem[] = [
  { repo: 'a/a', source: 'cncf' },
  { repo: 'b/b', source: 'cncf' },
  { repo: 'c/c', source: 'discovery' },
];

function deps(overrides: Partial<CrawlDeps> = {}): CrawlDeps {
  return {
    counters: emptyCounters(),
    fetchRepo: vi.fn(async () => ({
      type: 'fetched' as const,
      content_hash: 'h',
      changed: true,
      icon_updated: true,
      requests: 4,
      points: 4,
    })),
    onFailure: vi.fn(async () => {}),
    quotaExhausted: () => false,
    concurrency: 2,
    onProgress: vi.fn(),
    ...overrides,
  };
}

describe('crawl', () => {
  it('counts a fetched repo, its icon and its cost', async () => {
    const counters = await crawl(items, deps());
    expect(counters).toMatchObject({
      repos_seen: 3,
      repos_fetched: 3,
      repos_unchanged: 0,
      icons_updated: 3,
      requests: 12,
      points_spent: 12,
    });
  });

  it('counts an unchanged repo apart from a fetched one', async () => {
    const counters = await crawl(items, deps({
      fetchRepo: vi.fn(async () => ({
        type: 'fetched' as const, content_hash: 'h', changed: false,
        icon_updated: false, requests: 1, points: 0,
      })),
    }));
    expect(counters).toMatchObject({ repos_fetched: 0, repos_unchanged: 3, points_spent: 0 });
  });

  it('counts a skip', async () => {
    const counters = await crawl(items, deps({
      fetchRepo: vi.fn(async () => ({ type: 'skipped' as const, reason: 'fork', requests: 1, points: 1 })),
    }));
    expect(counters).toMatchObject({ repos_skipped: 3, repos_fetched: 0 });
  });

  it('one bad repo never aborts the run', async () => {
    const fetchRepo = vi.fn(async (repo: string) => {
      if (repo === 'b/b') throw new Error('boom');
      return { type: 'fetched' as const, content_hash: 'h', changed: true, icon_updated: false, requests: 1, points: 1 };
    });
    const onFailure = vi.fn(async () => {});
    const counters = await crawl(items, deps({ fetchRepo, onFailure }));

    // §13: catch per item, emit RepoFailed, continue.
    expect(counters).toMatchObject({ repos_seen: 3, repos_fetched: 2, repos_failed: 1 });
    expect(onFailure).toHaveBeenCalledWith('b/b', expect.objectContaining({ message: 'boom' }));
  });

  it('stops when the quota is exhausted rather than sleeping out the window', async () => {
    let calls = 0;
    const fetchRepo = vi.fn(async () => {
      calls += 1;
      return { type: 'fetched' as const, content_hash: 'h', changed: true, icon_updated: false, requests: 1, points: 1 };
    });
    const counters = await crawl(items, deps({
      fetchRepo,
      concurrency: 1,
      quotaExhausted: () => calls >= 1,
    }));
    // The next run resumes for free: every repo already fetched now answers 304.
    expect(counters.repos_seen).toBe(1);
    expect(counters.rate_limited).toBeGreaterThan(0);
  });

  it('runs items concurrently up to the configured limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchRepo = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { type: 'fetched' as const, content_hash: 'h', changed: true, icon_updated: false, requests: 1, points: 1 };
    });
    await crawl(items, deps({ fetchRepo, concurrency: 2 }));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('reports progress as it goes', async () => {
    const onProgress = vi.fn();
    await crawl(items, deps({ onProgress }));
    expect(onProgress).toHaveBeenCalled();
    const last = onProgress.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ done: 3, known: 3 });
  });

  it('handles an empty worklist', async () => {
    const counters = await crawl([], deps());
    expect(counters).toMatchObject({ repos_seen: 0, repos_fetched: 0 });
  });
});
