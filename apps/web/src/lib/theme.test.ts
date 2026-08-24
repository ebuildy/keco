// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEY, applyTheme, readStoredTheme, resolveTheme } from './theme';

describe('readStoredTheme', () => {
  beforeEach(() => localStorage.clear());

  it('returns a stored preference', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('returns null when nothing is stored', () => {
    expect(readStoredTheme()).toBeNull();
  });

  it('ignores a value that is not a theme, rather than stamping it on the document', () => {
    localStorage.setItem(STORAGE_KEY, 'solarized');
    expect(readStoredTheme()).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('prefers an explicit stored choice over the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('falls through to the system preference when nothing is stored', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
  });
});

describe('applyTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('stamps the attribute and persists the choice', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });
});
