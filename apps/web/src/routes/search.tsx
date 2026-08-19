import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isSortKey, selectionFromParams } from '@keco/core';
import { searchTools, type PortalSearchResult } from '../lib/search';

/**
 * Search (AGENTS.md §9). State lives in the URL (`?q=&kind=&domain=&install=&sort=&view=`) so
 * results are shareable and back/forward work — `useSearchParams` is the only state store on
 * this page, deliberately.
 *
 * Every taxonomy family is readable from the URL by its declared `param`
 * (`selectionFromParams`), so adding a family needs no change here (§6).
 *
 * The facet sidebar, list/grid toggle and keyboard navigation are ROADMAP v1 items; this is
 * the ported baseline, not the finished page.
 */
const DEBOUNCE_MS = 80;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [results, setResults] = useState<PortalSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  // The URL is untrusted input: narrow it rather than casting (§14).
  const key = params.toString();

  useEffect(() => {
    let cancelled = false;
    // ~80 ms, so search-as-you-type does not issue a query per keystroke (§9).
    const timer = setTimeout(() => {
      searchTools({
        q,
        filters: selectionFromParams(params),
        sort: isSortKey(sort) ? sort : 'relevance',
        page,
      })
        .then((next) => !cancelled && (setResults(next), setError(null)))
        .catch(() => !cancelled && setError('Search is unavailable right now.'));
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` is the whole URL query: one dependency that changes exactly when a query should
    // be re-issued, and never when an unrelated re-render happens.
  }, [key]);

  return (
    <main>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('q');
          const next = new URLSearchParams(params);
          next.set('q', typeof value === 'string' ? value : '');
          next.delete('page');
          setParams(next);
        }}
      >
        <input name="q" type="search" defaultValue={q} aria-label="Search" />
        <button type="submit">Search</button>
      </form>

      {error && <p role="alert">{error}</p>}

      {results && (
        <>
          <p>
            {results.total} tools · {results.processingTimeMs} ms
          </p>

          {results.total === 0 && (
            // Empty and zero-result states must suggest something useful (§9).
            <section>
              <h2>No matches</h2>
              <p>
                Try a broader term, or browse by <Link to="/search?kind=operator">operators</Link>,{' '}
                <Link to="/search?domain=observability">observability</Link> or{' '}
                <Link to="/search?install=krew">kubectl plugins</Link>.
              </p>
            </section>
          )}

          <ul>
            {results.hits.map((tool) => (
              <li key={tool.id}>
                <Link to={`/tools/${tool.full_name}`}>{tool.full_name}</Link>
                <p>{tool.summary}</p>
                <small>
                  {tool.kind} · {tool.domains.join(', ')} · ★ {tool.stars}
                  {tool.archived && ' · archived'}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
