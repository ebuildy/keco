/**
 * Keyboard navigation for the result list (AGENTS.md §9), as pure functions so the rules are
 * testable without a DOM and the component that binds them holds no branching.
 *
 * Roving tabindex rather than aria-activedescendant: results are links, and a genuinely
 * focused link gets Enter, middle-click and "open in new tab" from the browser instead of
 * from handlers we would have to write and would get subtly wrong.
 */
export type FocusMove = 'next' | 'previous';

/**
 * Clamps at the end and returns null past the start. The asymmetry is deliberate: ↑ from the
 * first result should return the reader to the search field, and wrapping to the last result
 * would instead scroll them to the bottom of the page.
 */
export function nextFocusIndex(
  current: number | null,
  move: FocusMove,
  count: number,
): number | null {
  if (count === 0) return null;
  if (current === null) return move === 'next' ? 0 : count - 1;

  const next = move === 'next' ? current + 1 : current - 1;
  if (next < 0) return null;
  return Math.min(next, count - 1);
}

/**
 * The roving index, clamped to the list actually on screen.
 *
 * The stored index is reset by the search page's URL writers, but not by `navigate()`, a
 * `<Link>`, or the back button — and the result list changes on all of those. Arrow down to
 * result 12, then run a query with 3 hits: a stored index of 11 matches no result, every one
 * of them gets `tabIndex={-1}`, and Tab skips the entire list with nothing to recover it,
 * because the index itself never changed.
 *
 * Clamping at the point of use rather than resetting in each writer means a navigation path
 * nobody anticipated cannot reintroduce the bug.
 */
export const clampFocus = (focused: number | null, count: number): number | null =>
  focused !== null && focused >= 0 && focused < count ? focused : null;

/** Typed loosely so it can be tested with plain objects rather than a synthetic DOM. */
type MaybeEditable = { tagName?: string; isContentEditable?: boolean } | null;

/** `/` focuses search — unless the reader is already typing, where it must stay a slash. */
export function isEditableTarget(target: MaybeEditable): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}
