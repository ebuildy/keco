import { describe, expect, it } from 'vitest';
import { STAR_BANDS, initialWindows, queryOf, split, type Window } from './windows';

const at = (iso: string) => new Date(iso);

// Fixed clock shared by the whole suite. `split` requires `now` explicitly (see windows.ts) so
// every call site here has to supply one; using a single constant keeps the trees the various
// tests walk identical to each other.
const NOW = at('2026-08-02T00:00:00Z');

describe('STAR_BANDS', () => {
  it('covers every star count from 0 upward with no gap and no overlap', () => {
    // Every band is either ">N" (the open top) or "A..B" or a bare "N".
    const bounds = STAR_BANDS.map((band) => {
      if (band.startsWith('>')) return { lo: Number(band.slice(1)) + 1, hi: Infinity };
      if (band.includes('..')) {
        const [lo, hi] = band.split('..');
        return { lo: Number(lo), hi: Number(hi) };
      }
      return { lo: Number(band), hi: Number(band) };
    }).sort((a, b) => a.lo - b.lo);

    expect(bounds[0]!.lo).toBe(0);
    expect(bounds.at(-1)!.hi).toBe(Infinity);
    for (let i = 1; i < bounds.length; i += 1) {
      expect(bounds[i]!.lo).toBe(bounds[i - 1]!.hi + 1);
    }
  });
});

describe('initialWindows', () => {
  it('starts with one unconstrained window per star band', () => {
    const windows = initialWindows('kubernetes');
    expect(windows).toHaveLength(STAR_BANDS.length);
    expect(windows.every((w) => w.created === null)).toBe(true);
    expect(queryOf(windows[0]!)).toBe('kubernetes stars:>5000');
  });
});

describe('split', () => {
  const band = (stars: string): Window => ({ base: 'kubernetes', stars, created: null });

  it('splits an unconstrained band into a pre-2014 bucket plus one window per year', () => {
    const parts = split(band('0'), NOW);

    expect(queryOf(parts[0]!)).toBe('kubernetes stars:0 created:2008-01-01..2013-12-31');
    expect(queryOf(parts[1]!)).toBe('kubernetes stars:0 created:2014-01-01..2014-12-31');
    expect(queryOf(parts.at(-1)!)).toBe('kubernetes stars:0 created:2026-01-01..2026-12-31');
    expect(parts).toHaveLength(1 + (2026 - 2013));
  });

  it('splits the pre-2014 bucket into its individual years', () => {
    const [multi] = split(band('0'), NOW);
    const parts = split(multi!, NOW);

    expect(parts).toHaveLength(6);
    expect(queryOf(parts[0]!)).toBe('kubernetes stars:0 created:2008-01-01..2008-12-31');
    expect(queryOf(parts.at(-1)!)).toBe('kubernetes stars:0 created:2013-01-01..2013-12-31');
  });

  it('splits a year into four calendar quarters', () => {
    const year: Window = { base: 'kubernetes', stars: '0', created: { kind: 'year', year: 2020 } };
    const parts = split(year, NOW);

    expect(parts.map(queryOf)).toEqual([
      'kubernetes stars:0 created:2020-01-01..2020-03-31',
      'kubernetes stars:0 created:2020-04-01..2020-06-30',
      'kubernetes stars:0 created:2020-07-01..2020-09-30',
      'kubernetes stars:0 created:2020-10-01..2020-12-31',
    ]);
  });

  it('splits a quarter into its three months', () => {
    const quarter: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'quarter', year: 2020, quarter: 1 },
    };

    expect(split(quarter, NOW).map(queryOf)).toEqual([
      'kubernetes stars:0 created:2020-01-01..2020-01-31',
      'kubernetes stars:0 created:2020-02-01..2020-02-29',
      'kubernetes stars:0 created:2020-03-01..2020-03-31',
    ]);
  });

  it('splits a month into days, respecting leap years', () => {
    const leap: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'month', year: 2020, month: 2 },
    };
    const common: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'month', year: 2021, month: 2 },
    };

    expect(split(leap, NOW)).toHaveLength(29);
    expect(split(common, NOW)).toHaveLength(28);
    expect(queryOf(split(leap, NOW).at(-1)!)).toBe('kubernetes stars:0 created:2020-02-29');
  });

  it('cannot split a single day — that is the floor', () => {
    const day: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'day', date: '2020-02-29' },
    };
    expect(split(day, NOW)).toEqual([]);
  });

  it('produces the same queries on every run, so resume state stays valid', () => {
    const monday = split(initialWindows('kubernetes')[5]!, at('2026-08-02T00:00:00Z'));
    const tuesday = split(initialWindows('kubernetes')[5]!, at('2026-08-03T11:00:00Z'));
    expect(monday.map(queryOf)).toEqual(tuesday.map(queryOf));
  });
});

// --- Exhaustiveness properties -------------------------------------------------------------
//
// This module's entire job is to guarantee every repo is reachable by some window. The
// example-based tests above pin specific renderings; they do not prove the tree has no gap —
// in fact three gap-producing mutations (wrong quarter→month offset for Q2-Q4, a month split
// capped at 30 days, a hardcoded leap year in month-end rendering) all survived them, because
// the examples only ever exercised quarter 1 and February. These two properties walk the
// *entire* split tree, down to day-level leaves, and would have caught all three.
//
// Independent of the implementation on purpose: `dayIndex`/`coverage` reimplement the interval
// math from scratch rather than calling `queryOf`/`createdRange`, so a bug in the production
// interval math doesn't also corrupt the check that's supposed to catch it.

/** Whole-number day index since the Unix epoch — lets interval endpoints compare with `===`. */
const dayIndex = (year: number, month1: number, day: number): number =>
  Math.round(Date.UTC(year, month1 - 1, day) / 86_400_000);

/** Independent last-day-of-month: computed the same idiom as production, checked directly. */
const lastDayOf = (year: number, month1: number): number =>
  new Date(Date.UTC(year, month1, 0)).getUTCDate();

/** Inclusive [start, end] day-index range this window's `created` field denotes. */
function coverage(window: Window, now: Date): readonly [number, number] {
  const created = window.created;
  if (created === null) {
    return [dayIndex(2008, 1, 1), dayIndex(now.getUTCFullYear(), 12, 31)];
  }
  switch (created.kind) {
    case 'years':
      return [dayIndex(created.from, 1, 1), dayIndex(created.to, 12, 31)];
    case 'year':
      return [dayIndex(created.year, 1, 1), dayIndex(created.year, 12, 31)];
    case 'quarter': {
      const firstMonth = (created.quarter - 1) * 3 + 1;
      const lastMonth = firstMonth + 2;
      return [
        dayIndex(created.year, firstMonth, 1),
        dayIndex(created.year, lastMonth, lastDayOf(created.year, lastMonth)),
      ];
    }
    case 'month':
      return [
        dayIndex(created.year, created.month, 1),
        dayIndex(created.year, created.month, lastDayOf(created.year, created.month)),
      ];
    case 'day': {
      const [y, m, d] = created.date.split('-').map(Number) as [number, number, number];
      return [dayIndex(y, m, d), dayIndex(y, m, d)];
    }
  }
}

/**
 * Recursively asserts that `split(window)`'s children exactly tile `window`'s own coverage:
 * sorted by start, the first starts where the parent starts, the last ends where the parent
 * ends, and each child starts exactly one day after the previous child ends — no gap, no
 * overlap, no stray day. Recurses to the day-level leaves.
 */
function assertExactPartition(window: Window, now: Date): void {
  const children = split(window, now);
  if (children.length === 0) return; // day-level leaf: nothing finer to check

  const [parentStart, parentEnd] = coverage(window, now);
  const ranges = children.map((child) => coverage(child, now)).sort((a, b) => a[0] - b[0]);

  expect(ranges[0]![0]).toBe(parentStart);
  expect(ranges.at(-1)![1]).toBe(parentEnd);
  for (let i = 1; i < ranges.length; i += 1) {
    expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1);
  }

  for (const child of children) assertExactPartition(child, now);
}

/**
 * Recursively asserts every window's rendered `created:` endpoints round-trip through
 * `Date.UTC` unchanged. An overflowing date (e.g. "2009-02-29", which doesn't exist) silently
 * normalises to March in JS Date arithmetic, so a round-trip mismatch is the tell.
 */
function assertRealDates(window: Window, now: Date): void {
  const match = /created:(\S+)/.exec(queryOf(window));
  if (match) {
    const range = match[1]!;
    const endpoints = range.includes('..') ? range.split('..') : [range];
    for (const endpoint of endpoints) {
      const [y, m, d] = endpoint.split('-').map(Number) as [number, number, number];
      const roundTrip = new Date(Date.UTC(y, m - 1, d));
      expect([roundTrip.getUTCFullYear(), roundTrip.getUTCMonth() + 1, roundTrip.getUTCDate()]).toEqual([
        y,
        m,
        d,
      ]);
    }
  }
  for (const child of split(window, now)) assertRealDates(child, now);
}

describe('exhaustiveness', () => {
  // The date-splitting tree is identical for every star band — `stars` is carried along
  // unchanged by `split` and never affects `created`. Walking one band's tree (~7k nodes down
  // to day-level leaves) exercises every distinct shape the algebra can produce; walking all
  // thirteen would be 13x the runtime for zero extra coverage.
  const root = initialWindows('kubernetes')[0]!;

  it('every subdivision partitions its parent exactly, all the way to day-level leaves', () => {
    assertExactPartition(root, NOW);
  });

  it('every rendered range endpoint, at every level, is a real calendar date', () => {
    assertRealDates(root, NOW);
  });
});
