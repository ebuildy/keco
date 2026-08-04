import { describe, expect, it } from 'vitest';
import { STAR_BANDS, initialWindows, queryOf, split, type Window } from './windows';

const at = (iso: string) => new Date(iso);

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
    const parts = split(band('0'), at('2026-08-02T00:00:00Z'));

    expect(queryOf(parts[0]!)).toBe('kubernetes stars:0 created:2008-01-01..2013-12-31');
    expect(queryOf(parts[1]!)).toBe('kubernetes stars:0 created:2014-01-01..2014-12-31');
    expect(queryOf(parts.at(-1)!)).toBe('kubernetes stars:0 created:2026-01-01..2026-12-31');
    expect(parts).toHaveLength(1 + (2026 - 2013));
  });

  it('splits the pre-2014 bucket into its individual years', () => {
    const [multi] = split(band('0'), at('2026-08-02T00:00:00Z'));
    const parts = split(multi!, at('2026-08-02T00:00:00Z'));

    expect(parts).toHaveLength(6);
    expect(queryOf(parts[0]!)).toBe('kubernetes stars:0 created:2008-01-01..2008-12-31');
    expect(queryOf(parts.at(-1)!)).toBe('kubernetes stars:0 created:2013-01-01..2013-12-31');
  });

  it('splits a year into four calendar quarters', () => {
    const year: Window = { base: 'kubernetes', stars: '0', created: { kind: 'year', year: 2020 } };
    const parts = split(year);

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

    expect(split(quarter).map(queryOf)).toEqual([
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

    expect(split(leap)).toHaveLength(29);
    expect(split(common)).toHaveLength(28);
    expect(queryOf(split(leap).at(-1)!)).toBe('kubernetes stars:0 created:2020-02-29');
  });

  it('cannot split a single day — that is the floor', () => {
    const day: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'day', date: '2020-02-29' },
    };
    expect(split(day)).toEqual([]);
  });

  it('produces the same queries on every run, so resume state stays valid', () => {
    const monday = split(initialWindows('kubernetes')[5]!, at('2026-08-02T00:00:00Z'));
    const tuesday = split(initialWindows('kubernetes')[5]!, at('2026-08-03T11:00:00Z'));
    expect(monday.map(queryOf)).toEqual(tuesday.map(queryOf));
  });
});
