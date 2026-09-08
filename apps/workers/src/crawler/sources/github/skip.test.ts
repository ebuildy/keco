import { describe, expect, it } from 'vitest';
import { decideSkip, STALE_MONTHS, FORK_STAR_FLOOR, ARCHIVED_STAR_FLOOR } from './skip';

const NOW = new Date('2026-09-05T00:00:00.000Z');
const base = { fork: false, archived: false, stars: 10, pushed_at: '2026-08-01T00:00:00.000Z' };

describe('decideSkip', () => {
  it('keeps an ordinary active repo', () => {
    expect(decideSkip(base, NOW)).toBeNull();
  });

  it('skips a low-star fork', () => {
    expect(decideSkip({ ...base, fork: true, stars: 12 }, NOW)).toEqual({ reason: 'fork' });
  });

  it('keeps a fork above the star floor', () => {
    expect(decideSkip({ ...base, fork: true, stars: FORK_STAR_FLOOR + 1 }, NOW)).toBeNull();
  });

  it('treats the fork star floor as exclusive', () => {
    expect(decideSkip({ ...base, fork: true, stars: FORK_STAR_FLOOR }, NOW)).toEqual({ reason: 'fork' });
  });

  it('skips an archived repo stale beyond the window', () => {
    expect(decideSkip({ ...base, archived: true, pushed_at: '2024-01-01T00:00:00.000Z' }, NOW))
      .toEqual({ reason: 'archived-stale' });
  });

  it('keeps an archived repo pushed inside the window', () => {
    expect(decideSkip({ ...base, archived: true, pushed_at: '2026-01-01T00:00:00.000Z' }, NOW)).toBeNull();
  });

  it('keeps a famous archived repo however stale', () => {
    expect(
      decideSkip(
        { ...base, archived: true, stars: ARCHIVED_STAR_FLOOR + 1, pushed_at: '2019-01-01T00:00:00.000Z' },
        NOW,
      ),
    ).toBeNull();
  });

  it('treats a null pushed_at on an archived repo as stale', () => {
    expect(decideSkip({ ...base, archived: true, pushed_at: null }, NOW)).toEqual({ reason: 'archived-stale' });
  });

  it('checks fork before archived so the reason is the cheaper truth', () => {
    expect(
      decideSkip({ ...base, fork: true, archived: true, stars: 1, pushed_at: '2019-01-01T00:00:00.000Z' }, NOW),
    ).toEqual({ reason: 'fork' });
  });

  it('exposes the stale window as 24 months', () => {
    expect(STALE_MONTHS).toBe(24);
  });
});
