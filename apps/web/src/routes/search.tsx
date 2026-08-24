import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  isSortKey,
  paramsFromSelection,
  selectionFromParams,
  toggleFacetValue,
  type SortKey,
} from '@keco/core';
import { ActiveFilters } from '../components/search/active-filters';
import { NoResults, SearchError } from '../components/search/empty-state';
import { FacetSidebar } from '../components/search/facet-sidebar';
import { ResultCard } from '../components/search/result-card';
import { isViewMode, SearchControls, type ViewMode } from '../components/search/search-controls';
import { facetGroups } from '../lib/facets';
import { isEditableTarget, nextFocusIndex } from '../lib/keyboard';
import { searchErrorMessage, searchTools, type PortalSearchResult } from '../lib/search';

/**
 * Search (AGENTS.md §9). State lives in the URL (`?q=&kind=&domain=&install=&sort=&view=`) so
 * results are shareable and back/forward work — `useSearchParams` is the only state store on
 * this page, deliberately. The two `useState`s below hold a server response and a focus index,
 * neither of which belongs in a URL.
 *
 * Every taxonomy family is read from the URL by its declared `param` (`selectionFromParams`)
 * and written back by `paramsFromSelection`, so adding a family needs no change here (§6).
 */
const DEBOUNCE_MS = 80;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [results, setResults] = useState<PortalSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<number | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const q = params.get('q') ?? '';
  const sortParam = params.get('sort') ?? '';
  // The URL is untrusted input: narrow it rather than casting (§14).
  const sort: SortKey = isSortKey(sortParam) ? sortParam : 'relevance';
  const viewParam = params.get('view') ?? '';
  const view: ViewMode = isViewMode(viewParam) ? viewParam : 'list';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const key = params.toString();

  const selection = useMemo(() => selectionFromParams(params), [key]);

  useEffect(() => {
    let cancelled = false;
    // ~80 ms, so search-as-you-type does not issue a query per keystroke (§9).
    const timer = setTimeout(() => {
      searchTools({ q, filters: selection, sort, page })
        .then((next) => !cancelled && (setResults(next), setError(null)))
        .catch((error: unknown) => !cancelled && setError(searchErrorMessage(error)));
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` is the whole URL query: one dependency that changes exactly when a query should
    // be re-issued, and never when an unrelated re-render happens.
  }, [key]);

  const groups = useMemo(
    () => facetGroups(results?.facets ?? {}, selection),
    [results?.facets, selection],
  );

  const hits = results?.hits ?? [];

  /** Focus follows the roving index rather than the render, so arrow keys move real focus. */
  useEffect(() => {
    if (focused !== null) resultRefs.current[focused]?.focus();
  }, [focused]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editable = isEditableTarget(event.target as HTMLElement | null);

      if (event.key === '/' && !editable) {
        event.preventDefault();
        searchRef.current?.focus();
        setFocused(null);
        return;
      }

      if (event.key === 'Escape' && focused !== null) {
        setFocused(null);
        searchRef.current?.focus();
        return;
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Inside the sidebar's checkboxes and the sort select, arrows mean what they always mean.
      if (editable) return;

      const next = nextFocusIndex(
        focused,
        event.key === 'ArrowDown' ? 'next' : 'previous',
        hits.length,
      );
      event.preventDefault();
      setFocused(next);
      if (next === null) searchRef.current?.focus();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused, hits.length]);

  /** Every URL write resets focus: the list under it is about to be a different list. */
  const write = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    mutate(next);
    setParams(next);
    setFocused(null);
  };

  const onToggleFacet = (familyId: string, value: string) => {
    setParams(paramsFromSelection(toggleFacetValue(selection, familyId, value), params));
    setFocused(null);
  };

  const onClear = () => {
    setParams(paramsFromSelection({}, params));
    setFocused(null);
  };

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-5">
      <div className="grid gap-6 lg:grid-cols-[210px_1fr]">
        <FacetSidebar
          groups={groups}
          onToggle={onToggleFacet}
          onClear={onClear}
          hasSelection={Object.keys(selection).length > 0}
        />

        <div className="min-w-0">
          {/* The header carries the search field from `lg` up; this is the narrow-screen one,
              and it owns `searchRef` so `/` has something to focus at every width. */}
          <form
            className="mb-4 flex items-center gap-2.5 rounded-card border border-line-strong bg-surface px-3.5 py-2.5 lg:hidden"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get('q');
              write((next) => {
                next.set('q', typeof value === 'string' ? value : '');
                next.delete('page');
              });
            }}
          >
            <span aria-hidden="true" className="text-faint">
              ⌕
            </span>
            <input
              ref={searchRef}
              key={q}
              name="q"
              type="search"
              defaultValue={q}
              aria-label="Search"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </form>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ActiveFilters groups={groups} onToggle={onToggleFacet} />
            {results && (
              <span className="ml-auto text-[11.5px] text-muted">
                <span className="font-mono tabular-nums">
                  {results.total.toLocaleString('en-GB')}
                </span>{' '}
                tools · <span className="font-mono">{results.processingTimeMs} ms</span>
              </span>
            )}
            <SearchControls
              sort={sort}
              view={view}
              onSort={(next) =>
                write((params) =>
                  next === 'relevance' ? params.delete('sort') : params.set('sort', next),
                )
              }
              onView={(next) =>
                write((params) =>
                  next === 'list' ? params.delete('view') : params.set('view', next),
                )
              }
            />
          </div>

          {error && <SearchError message={error} />}

          {results && results.total === 0 && !error && <NoResults query={q} />}

          {hits.length > 0 && (
            <ul className={view === 'grid' ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2.5'}>
              {hits.map((tool, index) => (
                <li key={tool.id}>
                  <ResultCard
                    tool={tool}
                    view={view}
                    // Exactly one result is tabbable, so Tab treats the list as a single stop
                    // and lands on whichever result the arrows last moved to.
                    tabIndex={focused === index || (focused === null && index === 0) ? 0 : -1}
                    ref={(node) => {
                      resultRefs.current[index] = node;
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
