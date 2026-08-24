import { describe, expect, it } from 'vitest';
import { clampFocus, isEditableTarget, nextFocusIndex } from './keyboard';

describe('nextFocusIndex', () => {
  it('enters the list from nothing focused', () => {
    expect(nextFocusIndex(null, 'next', 5)).toBe(0);
    expect(nextFocusIndex(null, 'previous', 5)).toBe(4);
  });

  it('moves within the list', () => {
    expect(nextFocusIndex(2, 'next', 5)).toBe(3);
    expect(nextFocusIndex(2, 'previous', 5)).toBe(1);
  });

  it('clamps rather than wrapping, so the ends are reachable and stable', () => {
    expect(nextFocusIndex(4, 'next', 5)).toBe(4);
    expect(nextFocusIndex(0, 'previous', 5)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(nextFocusIndex(null, 'next', 0)).toBeNull();
  });
});

describe('clampFocus', () => {
  it('keeps an index the list still has', () => {
    expect(clampFocus(2, 5)).toBe(2);
    expect(clampFocus(0, 1)).toBe(0);
  });

  it('drops an index the list has outgrown, which is the whole point', () => {
    // Reachable: arrow to result 12, then search for something with 3 hits. Left unclamped,
    // every result renders tabIndex={-1} and Tab skips the list entirely.
    expect(clampFocus(11, 3)).toBeNull();
    expect(clampFocus(0, 0)).toBeNull();
  });

  it('passes null through and rejects a negative index', () => {
    expect(clampFocus(null, 5)).toBeNull();
    expect(clampFocus(-1, 5)).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('is true for text entry, so "/" does not hijack a keystroke', () => {
    expect(isEditableTarget({ tagName: 'INPUT', isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for ordinary elements and for nothing at all', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
