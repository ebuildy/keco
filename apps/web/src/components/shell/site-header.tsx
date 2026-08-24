import { Link, useLocation, useNavigate } from 'react-router';
import { SITE_SEARCH_ID } from '../../lib/site-search';
import { ThemeToggle } from './theme-toggle';

/**
 * The compact search field is omitted on `/`, where the hero field is the page's subject and a
 * second one would be two controls competing for the same job.
 *
 * `key={query}` on the input is what makes the field track the URL: react-router keeps this
 * component mounted across a client navigation, so a `defaultValue` alone would show a stale
 * query after the reader follows a link into a different search.
 */
export function SiteHeader() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const isHome = pathname === '/';
  const query = new URLSearchParams(search).get('q') ?? '';

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface">
      <div className="mx-auto flex max-w-[1200px] items-center gap-4 px-4 py-2.5">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 text-[15px] font-bold tracking-tight text-fg"
        >
          <span
            aria-hidden="true"
            className="inline-block h-5 w-[18px] bg-accent"
            style={{ clipPath: 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)' }}
          />
          Keco
        </Link>

        {!isHome && (
          <form
            className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-line-strong bg-bg px-3 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get('q');
              void navigate(
                `/search?q=${encodeURIComponent(typeof value === 'string' ? value : '')}`,
              );
            }}
          >
            <span aria-hidden="true" className="text-faint">
              ⌕
            </span>
            <input
              id={SITE_SEARCH_ID}
              key={query}
              name="q"
              type="search"
              defaultValue={query}
              aria-label="Search the Kubernetes ecosystem"
              placeholder="Search the ecosystem"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </form>
        )}

        <div className="ml-auto shrink-0">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
