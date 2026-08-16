import { split, type Window } from './windows';

/**
 * What to do with a window once its probe page has come back (design 2026-08-02).
 *
 * This is the only real decision the orchestration loop makes, so it lives here — pure,
 * clock-injected, unit-tested — rather than inside `index.ts`, which executes `main()` on
 * import and therefore cannot be imported by a test.
 */

/** GitHub Search never returns more than this, however many pages you ask for. */
export const MAX_RESULTS_PER_QUERY = 1000;

/** GitHub Search's own per-page cap. */
export const PER_PAGE = 100;

export type WindowPlan = {
  /**
   * Last page to fetch, inclusive. Page 1 is the probe the caller has already spent, so
   * `lastPage === 1` means "nothing more to fetch for this window".
   */
  lastPage: number;
  /** Sub-windows to enqueue. Empty when the window fits, or when it has hit the day floor. */
  children: Window[];
  /** The window is over the cap and cannot be subdivided further — results are lost. */
  truncated: boolean;
};

/**
 * Three outcomes, in the order the design specifies:
 *
 *  - **fits** (`total_count <= 1000`): paginate to exhaustion, no children.
 *  - **too big, splittable**: keep the probe's 100 items (dedup absorbs them) and subdivide.
 *    Deliberately does *not* paginate — the children cover the same repos and pagination here
 *    would spend up to nine extra search requests for results we are about to fetch anyway.
 *  - **too big, at the day floor**: cannot subdivide, so take everything GitHub will give —
 *    all ten pages — and report `truncated` so the caller can warn. The plan text stopped at
 *    the probe page here, which would have thrown away 900 of the 1000 reachable repos on
 *    exactly the densest days in the corpus.
 */
export function planWindow(
  window: Window,
  totalCount: number,
  now: Date,
  perPage: number = PER_PAGE,
): WindowPlan {
  if (totalCount <= MAX_RESULTS_PER_QUERY) {
    return { lastPage: pagesFor(totalCount, perPage), children: [], truncated: false };
  }

  const children = split(window, now);
  if (children.length > 0) return { lastPage: 1, children, truncated: false };

  return { lastPage: pagesFor(MAX_RESULTS_PER_QUERY, perPage), children: [], truncated: true };
}

/**
 * At least 1 — the probe page is always spent, even on an empty result set — and never so far
 * that `page * perPage` crosses the 1000-result cap, which `SearchClient.page()` rejects
 * outright.
 *
 * The ceiling has to be a *floor* division, and only `PER_PAGE === 100` hides it: at
 * `perPage: 30`, `ceil(1000/30)` is 34 and `34 * 30` is 1020, so every truncated window would
 * throw and be recorded as failed instead of yielding its 990 reachable repos.
 */
const pagesFor = (count: number, perPage: number): number =>
  Math.max(1, Math.min(Math.ceil(count / perPage), Math.floor(MAX_RESULTS_PER_QUERY / perPage)));
