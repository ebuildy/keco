import { Link } from 'react-router';

/**
 * Empty and zero-result states must suggest something useful (§9).
 *
 * An empty index is the normal state before the first crawl, not a failure, and must not read
 * like one — which is why the no-query copy differs from the no-match copy.
 */
export function NoResults({ query }: { query: string }) {
  return (
    <section className="rounded-card border border-line bg-surface px-5 py-8 text-center">
      <h2 className="text-[15px] font-semibold text-fg">
        {query ? `Nothing matches “${query}”` : 'Nothing here yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
        Try a broader term, or drop a filter. You can also browse{' '}
        <Link to="/search?kind=operator" className="text-accent-text">
          operators
        </Link>
        ,{' '}
        <Link to="/search?domain=observability" className="text-accent-text">
          observability
        </Link>{' '}
        or{' '}
        <Link to="/search?install=krew" className="text-accent-text">
          kubectl plugins
        </Link>
        .
      </p>
    </section>
  );
}

/**
 * `searchErrorMessage` distinguishes a missing `VITE_MEILI_SEARCH_KEY` from a genuine outage,
 * and that distinction is the point: one is a build misconfiguration somebody can fix, the
 * other is nothing the reader can act on. Rendering both as "unavailable" would hide the
 * first behind the second (§12).
 */
export function SearchError({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-card border border-line bg-surface px-4 py-3">
      <p className="text-sm font-medium text-bad">{message}</p>
    </div>
  );
}
