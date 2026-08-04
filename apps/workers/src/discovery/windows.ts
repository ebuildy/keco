/**
 * Search windows (design 2026-08-02).
 *
 * GitHub Search returns at most 1000 results per query, so a keyword is split into star
 * bands, and any band still over 1000 is subdivided by creation date until it fits.
 *
 * Boundaries are calendar-aligned rather than bisected, and that is load-bearing: a resumed
 * sweep matches completed windows by query string, so a window whose bounds shifted with the
 * current date would invalidate every resume. `created:2020-01-01..2020-03-31` means the same
 * thing tomorrow.
 *
 * Pure: no network, no cache, no ambient clock.
 */

/** Kubernetes launched in 2014; GitHub opened in 2008. Everything older is one bucket. */
export const GITHUB_EPOCH_YEAR = 2008;
export const EARLY_YEARS_END = 2013;

/**
 * Coarse at the top where repos are few, fine at the bottom where the long tail lives.
 * Must remain contiguous from 0 upward — windows.test.ts asserts it.
 */
export const STAR_BANDS = [
  '>5000',
  '1000..5000',
  '500..999',
  '200..499',
  '100..199',
  '50..99',
  '20..49',
  '10..19',
  '5..9',
  '3..4',
  '2',
  '1',
  '0',
] as const;

export type Created =
  | { kind: 'years'; from: number; to: number }
  | { kind: 'year'; year: number }
  | { kind: 'quarter'; year: number; quarter: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'day'; date: string };

export type Window = {
  base: string;
  stars: string;
  created: Created | null;
};

export function initialWindows(base: string): Window[] {
  return STAR_BANDS.map((stars) => ({ base, stars, created: null }));
}

/** Sub-windows one level finer. An empty result means the floor: a single day. */
export function split(window: Window, now = new Date()): Window[] {
  return splitCreated(window.created, now.getUTCFullYear()).map((created) => ({
    ...window,
    created,
  }));
}

function splitCreated(created: Created | null, currentYear: number): Created[] {
  if (created === null) {
    const out: Created[] = [{ kind: 'years', from: GITHUB_EPOCH_YEAR, to: EARLY_YEARS_END }];
    for (let year = EARLY_YEARS_END + 1; year <= currentYear; year += 1) {
      out.push({ kind: 'year', year });
    }
    return out;
  }

  switch (created.kind) {
    case 'years': {
      const out: Created[] = [];
      for (let year = created.from; year <= created.to; year += 1) out.push({ kind: 'year', year });
      return out;
    }
    case 'year':
      return [1, 2, 3, 4].map((quarter) => ({ kind: 'quarter', year: created.year, quarter }));
    case 'quarter': {
      const first = (created.quarter - 1) * 3 + 1;
      return [first, first + 1, first + 2].map((month) => ({
        kind: 'month',
        year: created.year,
        month,
      }));
    }
    case 'month': {
      const out: Created[] = [];
      for (let day = 1; day <= daysInMonth(created.year, created.month); day += 1) {
        out.push({ kind: 'day', date: iso(created.year, created.month, day) });
      }
      return out;
    }
    case 'day':
      return [];
  }
}

/** The GitHub search query this window represents. Doubles as its identity in resume state. */
export function queryOf(window: Window): string {
  const parts = [window.base, `stars:${window.stars}`];
  const range = createdRange(window.created);
  if (range !== null) parts.push(`created:${range}`);
  return parts.join(' ');
}

function createdRange(created: Created | null): string | null {
  if (created === null) return null;
  switch (created.kind) {
    case 'years':
      return `${created.from}-01-01..${created.to}-12-31`;
    case 'year':
      return `${created.year}-01-01..${created.year}-12-31`;
    case 'quarter': {
      const first = (created.quarter - 1) * 3 + 1;
      const last = first + 2;
      return `${iso(created.year, first, 1)}..${iso(created.year, last, daysInMonth(created.year, last))}`;
    }
    case 'month':
      return `${iso(created.year, created.month, 1)}..${iso(
        created.year,
        created.month,
        daysInMonth(created.year, created.month),
      )}`;
    case 'day':
      return created.date;
  }
}

/** `month` is 1-indexed; day 0 of the next month is the last day of this one. */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const pad = (value: number): string => String(value).padStart(2, '0');
const iso = (year: number, month: number, day: number): string =>
  `${year}-${pad(month)}-${pad(day)}`;
