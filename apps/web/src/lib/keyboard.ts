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

/** Typed loosely so it can be tested with plain objects rather than a synthetic DOM. */
type MaybeEditable = { tagName?: string; isContentEditable?: boolean } | null;

/** `/` focuses search — unless the reader is already typing, where it must stay a slash. */
export function isEditableTarget(target: MaybeEditable): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}
