// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { focusSiteSearch, isSiteSearchTarget, SITE_SEARCH_ID } from './site-search';

describe('isSiteSearchTarget', () => {
  it('recognises the search field', () => {
    expect(isSiteSearchTarget({ id: SITE_SEARCH_ID })).toBe(true);
  });

  it('rejects any other element, and nothing at all', () => {
    expect(isSiteSearchTarget({ id: 'sort' })).toBe(false);
    expect(isSiteSearchTarget({})).toBe(false);
    expect(isSiteSearchTarget(null)).toBe(false);
  });
});

describe('focusSiteSearch', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('focuses the field and puts the caret after the existing query', () => {
    document.body.innerHTML = `<input id="${SITE_SEARCH_ID}" value="ingress">`;
    focusSiteSearch();

    const field = document.getElementById(SITE_SEARCH_ID) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    // Not selected: `/` must not arm the next keystroke to wipe what the reader typed.
    expect(field.selectionStart).toBe('ingress'.length);
    expect(field.selectionEnd).toBe('ingress'.length);
  });

  it('does nothing when no field is mounted, rather than throwing', () => {
    expect(() => focusSiteSearch()).not.toThrow();
  });

  it('ignores an element carrying the id that is not an input', () => {
    // Guards the shared-id contract: if a future refactor ever puts the id on a wrapper, this
    // fails loudly here instead of silently making `/` inert again.
    document.body.innerHTML = `<div id="${SITE_SEARCH_ID}"></div>`;
    expect(() => focusSiteSearch()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});
