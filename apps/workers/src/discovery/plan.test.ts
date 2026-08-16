import { describe, expect, it } from 'vitest';
import { MAX_RESULTS_PER_QUERY, PER_PAGE, planWindow } from './plan';
import type { Window } from './windows';

const NOW = new Date('2026-08-02T09:30:00Z');

const window = (created: Window['created'] = null): Window => ({
  base: 'kubernetes',
  stars: '0',
  created,
});

describe('planWindow', () => {
  it('paginates to exhaustion when the window fits under the cap', () => {
    const plan = planWindow(window(), 250, NOW);

    expect(plan.lastPage).toBe(3);
    expect(plan.children).toEqual([]);
    expect(plan.truncated).toBe(false);
  });

  it('spends only the probe page on an empty window', () => {
    expect(planWindow(window(), 0, NOW).lastPage).toBe(1);
  });

  it('treats exactly the cap as fitting', () => {
    const plan = planWindow(window(), MAX_RESULTS_PER_QUERY, NOW);

    expect(plan.lastPage).toBe(MAX_RESULTS_PER_QUERY / PER_PAGE);
    expect(plan.children).toEqual([]);
    expect(plan.truncated).toBe(false);
  });

  it('splits instead of paginating when the window is over the cap', () => {
    const plan = planWindow(window({ kind: 'year', year: 2020 }), 40_000, NOW);

    // The probe's 100 items are kept; the rest arrive via the children, so paging this window
    // further would spend requests on repos we are about to fetch anyway.
    expect(plan.lastPage).toBe(1);
    expect(plan.truncated).toBe(false);
    expect(plan.children.map((child) => child.created)).toEqual([
      { kind: 'quarter', year: 2020, quarter: 1 },
      { kind: 'quarter', year: 2020, quarter: 2 },
      { kind: 'quarter', year: 2020, quarter: 3 },
      { kind: 'quarter', year: 2020, quarter: 4 },
    ]);
  });

  it('expands an unconstrained window against the injected clock, not the wall clock', () => {
    const plan = planWindow(window(), 400_000, new Date('2031-06-01T00:00:00Z'));

    expect(plan.children.at(-1)?.created).toEqual({ kind: 'year', year: 2031 });
  });

  it('takes the full 1000 and reports truncation at the day floor', () => {
    const plan = planWindow(window({ kind: 'day', date: '2020-04-17' }), 4_200, NOW);

    // The floor case is the one that must NOT stop at the probe page: a day window is
    // unsplittable, so everything past page 1 is lost for good if it is not fetched now.
    expect(plan.lastPage).toBe(MAX_RESULTS_PER_QUERY / PER_PAGE);
    expect(plan.children).toEqual([]);
    expect(plan.truncated).toBe(true);
  });

  it('never plans a page past the 1000-result cap, at any page size', () => {
    // `SearchClient.page()` rejects `page * perPage > 1000` before spending a rate slot, so a
    // plan that crosses the cap turns every truncated window into a failed one. Only
    // perPage=100 divides 1000 evenly, which is what hid this.
    for (const perPage of [1, 7, 30, 33, 50, 64, 100]) {
      for (const total of [0, 1, 99, 100, 999, 1000, 1001, 40_000]) {
        const plan = planWindow(window({ kind: 'day', date: '2020-04-17' }), total, NOW, perPage);
        expect(plan.lastPage * perPage).toBeLessThanOrEqual(MAX_RESULTS_PER_QUERY);
        expect(plan.lastPage).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('takes as many whole pages as fit under the cap at an uneven page size', () => {
    const plan = planWindow(window({ kind: 'day', date: '2020-04-17' }), 4_200, NOW, 30);

    // ceil(1000/30) is 34, and 34*30 = 1020 would be rejected; 33 pages is 990 repos.
    expect(plan.lastPage).toBe(33);
    expect(plan.truncated).toBe(true);
  });

  it('carries base and stars through to every child', () => {
    const plan = planWindow(window({ kind: 'quarter', year: 2022, quarter: 3 }), 2_000, NOW);

    expect(plan.children.every((child) => child.base === 'kubernetes' && child.stars === '0')).toBe(
      true,
    );
  });
});
