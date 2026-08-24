import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/**
 * Header, content, footer — and the one thing every route shares.
 *
 * It renders inside the prerender too, so a crawler sees the navigation and the skip link, not
 * just the page body. Nothing here fetches or touches `document`, which is what keeps that
 * true (§9).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:m-2 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      <SiteHeader />
      <div id="content" className="flex-1">
        {children}
      </div>
      <SiteFooter />
    </div>
  );
}
