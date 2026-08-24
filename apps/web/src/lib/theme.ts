/**
 * The theme preference, and the only state the toggle owns.
 *
 * The attribute is stamped before paint by the inline script in index.html — this module is
 * what changes it afterwards. Storage is treated as unavailable rather than assumed: private
 * mode and blocked third-party storage both throw on access, and a portal that white-screens
 * because someone hardened their browser is a worse bug than a lost preference.
 */
export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'keco-theme';

const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

export function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Pure, so the precedence rule is testable without a browser. */
export const resolveTheme = (stored: Theme | null, systemPrefersDark: boolean): Theme =>
  stored ?? (systemPrefersDark ? 'dark' : 'light');

export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* The attribute is set either way; only persistence is lost. */
  }
}

/** What the toggle should show on mount: the attribute if the inline script set one, else the OS. */
export function currentTheme(): Theme {
  const stamped = document.documentElement.dataset.theme;
  return isTheme(stamped) ? stamped : resolveTheme(null, systemPrefersDark());
}
