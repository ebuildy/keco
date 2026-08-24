import { useEffect } from 'react';
import { isEditableTarget } from '../../lib/keyboard';
import { focusSiteSearch } from '../../lib/site-search';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * Header, content, footer — and the one thing every route shares.
 *
 * It renders inside the prerender too, so a crawler sees the navigation and the skip link, not
 * just the page body. Nothing here fetches, and the only DOM access is inside an effect, which
 * is what keeps that true (§9).
 *
 * The `/` shortcut lives here rather than on the search page because the home page tells every
 * reader "Press / anywhere to search" — and "anywhere" has to include the tool page and the
 * 404, which is where someone who has just landed from Google actually is. A per-route
 * listener could only ever make the promise true on one route.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // While the reader is typing, `/` is a slash. That includes the search field itself,
      // so this cannot steal a keystroke from the thing it focuses.
      if (event.key !== '/' || isEditableTarget(event.target as HTMLElement | null)) return;
      event.preventDefault();
      focusSiteSearch();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:m-2 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      <SiteHeader />
      {/* tabIndex so the skip link actually lands focus here in Safari, not just scrolls. */}
      <div id="content" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </div>
      <SiteFooter />
    </div>
  );
}
