import { useEffect, useState } from 'react';
import { applyTheme, currentTheme, type Theme } from '../../lib/theme';

/**
 * Reads its initial value from the attribute the inline script in index.html already stamped,
 * so the control can never disagree with what is on screen.
 *
 * `useEffect` rather than a `useState` initialiser is not a style choice: the prerender runs
 * this component through `renderToString`, where there is no `document` and no `localStorage`.
 * `currentTheme()` touches both. Reading it during render crashes `mise run build` on the
 * prerender step — the button renders in its light state and corrects itself on hydration.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => setTheme(currentTheme()), []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      aria-label={`Switch to the ${next} theme`}
      aria-pressed={theme === 'dark'}
      className="rounded-control border border-line px-2 py-1 text-sm text-muted transition-colors hover:text-fg"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
