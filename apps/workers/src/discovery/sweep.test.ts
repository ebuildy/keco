import { describe, expect, it } from 'vitest';
import type { DiscoveryState } from './store/collections';
import { beginSweep } from './sweep';
import { STAR_BANDS } from './windows';

const NOW = new Date('2026-08-02T09:30:00Z');

const state = (overrides: Partial<DiscoveryState> = {}): DiscoveryState => ({
  query: 'kubernetes',
  started_at: '2026-07-01T00:00:00Z',
  pending_windows: [],
  completed_windows: [],
  failed_windows: [],
  repos_seen: 0,
  pages_fetched: 0,
  dropped: 0,
  ...overrides,
});

describe('beginSweep', () => {
  it('resumes and touches nothing when windows are still pending', () => {
    const s = state({
      pending_windows: [{ base: 'kubernetes', stars: '0', created: null }],
      completed_windows: ['kubernetes stars:>5000'],
      failed_windows: [{ window: 'kubernetes stars:1', error: 'boom' }],
      pages_fetched: 75,
      dropped: 3,
      started_at: '2026-07-01T00:00:00Z',
    });

    expect(beginSweep(s, 'kubernetes', NOW)).toBe(true);
    expect(s.pending_windows).toHaveLength(1);
    expect(s.completed_windows).toEqual(['kubernetes stars:>5000']);
    expect(s.failed_windows).toHaveLength(1);
    expect(s.pages_fetched).toBe(75);
    expect(s.dropped).toBe(3);
    expect(s.started_at).toBe('2026-07-01T00:00:00Z');
  });

  it('starts a new sweep over every star band when the queue is empty', () => {
    const s = state();

    expect(beginSweep(s, 'kubernetes', NOW)).toBe(false);
    expect(s.pending_windows).toHaveLength(STAR_BANDS.length);
    expect(s.pending_windows.every((w) => w.base === 'kubernetes' && w.created === null)).toBe(
      true,
    );
    expect(s.started_at).toBe(NOW.toISOString());
  });

  it('resets the per-sweep counters and window bookkeeping of a finished sweep', () => {
    // The bug this covers: `pages_fetched` (and later `dropped`) carried over from the previous
    // sweep, so the second sweep reported the first one's totals plus its own.
    const s = state({
      completed_windows: ['kubernetes stars:>5000', 'kubernetes stars:0'],
      failed_windows: [{ window: 'kubernetes stars:1', error: 'boom' }],
      pages_fetched: 2_140,
      dropped: 17,
    });

    beginSweep(s, 'kubernetes', NOW);

    expect(s.completed_windows).toEqual([]);
    expect(s.failed_windows).toEqual([]);
    expect(s.pages_fetched).toBe(0);
    expect(s.dropped).toBe(0);
  });

  it('leaves the corpus counter alone — the repo list and hashes survive a new sweep', () => {
    // `repos_seen` mirrors the store's in-memory list, which `beginSweep` must not touch:
    // carrying the corpus over is exactly what lets a re-sweep skip unchanged documents.
    const s = state({ repos_seen: 42_904 });

    beginSweep(s, 'kubernetes', NOW);

    expect(s.repos_seen).toBe(42_904);
  });

  it('builds the new queue from the query it is given, not the one in state', () => {
    const s = state({ query: 'kubernetes' });

    beginSweep(s, 'istio', NOW);

    expect(s.pending_windows.every((w) => w.base === 'istio')).toBe(true);
  });
});
