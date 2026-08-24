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
import { clampFocus, isEditableTarget, nextFocusIndex } from '../lib/keyboard';
import {
  browseFacets,
  searchErrorMessage,
  searchTools,
  verifySuggestions,
  type PortalSearchResult,
  type VerifiedSuggestion,
} from '../lib/search';
import { focusSiteSearch, isSiteSearchTarget } from '../lib/site-search';
import { suggestQueries } from '../lib/spelling';
import { topCategories, type Chip } from '../lib/topics';

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
  const [categories, setCategories] = useState<Chip[]>([]);
  const [suggestions, setSuggestions] = useState<VerifiedSuggestion[]>([]);

  const resultRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const categoriesRequested = useRef(false);

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

  // Clamped, so a navigation that shrank the list cannot strand focus on an index that no
  // longer exists. `clampFocus` carries the reasoning and the tests.
  const active = clampFocus(focused, hits.length);
  const hasSidebar = groups.length > 0;
  const activeFilterCount = Object.values(selection).reduce((sum, list) => sum + list.length, 0);
  const showEmptyState = results !== null && results.total === 0 && error === null;

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

  /**
   * "Did you mean?", proven before it is offered.
   *
   * Candidates are generated in the browser for free; the single `multiSearch` that follows is
   * what turns them from guesses into promises, and it runs only on a query that already came
   * back empty. Keyed on `key` rather than a ref, unlike the categories below, because a
   * different failing query deserves a different set of suggestions — while the corpus's
   * popular categories are the same all session.
   *
   * Failure is silent. The page is already telling the reader their search went nowhere, and a
   * second error about the machinery behind a nicety would be noise.
   */
  useEffect(() => {
    if (!showEmptyState) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    verifySuggestions(suggestQueries(q), selection)
      .then((verified) => !cancelled && setSuggestions(verified))
      .catch(() => !cancelled && setSuggestions([]));
    return () => {
      cancelled = true;
    };
  }, [showEmptyState, key]);

  /**
   * The corpus's most populated categories, for the zero-result state to offer.
   *
   * This is a second query, so it is bought deliberately and only once: it fires the first time
   * a search comes back empty and never again for the life of the page. The distribution it
   * reads is corpus-wide and unfiltered — which is the whole point, since the filtered one is
   * empty by definition here — and it does not change while the reader is on the page.
   *
   * A failure is swallowed. These are a helpful extra on a page that is already telling the
   * reader something went nowhere; turning that into a second error message would be worse
   * than quietly showing no chips.
   */
  useEffect(() => {
    if (!showEmptyState || categoriesRequested.current) return;
    categoriesRequested.current = true;

    let cancelled = false;
    browseFacets()
      .then((browse) => !cancelled && setCategories(topCategories(browse.facets)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showEmptyState]);

  /** Focus follows the roving index rather than the render, so arrow keys move real focus. */
  useEffect(() => {
    if (active !== null) resultRefs.current[active]?.focus();
  }, [active]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const onSearchField = isSiteSearchTarget(target);

      if (event.key === 'Escape') {
        // From a result: hand focus back to the field the reader came from.
        if (active !== null) {
          setFocused(null);
          focusSiteSearch();
          return;
        }
        // From the field: clear the query (§9's keyboard contract). `type="search"` gives
        // WebKit and Blink a native clear, but that empties the visible value only and leaves
        // `?q=` and the results standing — which reads as a broken control rather than no
        // control at all. Clearing the URL is what actually resets the page.
        if (onSearchField && q !== '') {
          event.preventDefault();
          write((next) => next.delete('q'));
          // The field is uncontrolled and keyed on `q`, so dropping the parameter remounts it
          // empty — and a remount drops focus. Restore it after React has committed.
          setTimeout(focusSiteSearch, 0);
        }
        return;
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

      // Arrows keep their normal meaning inside the sidebar's checkboxes and the sort
      // `<select>` — but not in the search field, where §9 says `↓` enters the result list.
      if (isEditableTarget(target) && !onSearchField) return;
      // From the field, only `↓` reaches the list; `↑` would otherwise jump the reader to the
      // last result from the top of the page.
      if (onSearchField && event.key !== 'ArrowDown') return;

      const next = nextFocusIndex(
        active,
        event.key === 'ArrowDown' ? 'next' : 'previous',
        hits.length,
      );
      event.preventDefault();
      setFocused(next);
      if (next === null) focusSiteSearch();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, hits.length, q, key]);

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-5">
      {/* The sidebar renders nothing when no family has hits — which is exactly the zero-result
          case. Keeping the two-column template would auto-place the sole remaining child into
          the 210px column, rendering the empty state in a sliver at the very moment it is the
          only thing on the page. */}
      <div className={hasSidebar ? 'grid gap-6 lg:grid-cols-[210px_1fr]' : ''}>
        <FacetSidebar
          groups={groups}
          onToggle={onToggleFacet}
          onClear={onClear}
          hasSelection={Object.keys(selection).length > 0}
        />

        <div className="min-w-0">
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

          {showEmptyState && (
            <NoResults
              query={q}
              activeFilterCount={activeFilterCount}
              categories={categories}
              suggestions={suggestions}
              onClearFilters={onClear}
              onClearQuery={() => write((next) => next.delete('q'))}
              onSuggestion={(next) => write((params) => params.set('q', next))}
            />
          )}

          {hits.length > 0 && (
            <ul className={view === 'grid' ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2.5'}>
              {hits.map((tool, index) => (
                <li key={tool.id}>
                  <ResultCard
                    tool={tool}
                    view={view}
                    // Exactly one result is tabbable, so Tab treats the list as a single stop
                    // and lands on whichever result the arrows last moved to.
                    tabIndex={active === index || (active === null && index === 0) ? 0 : -1}
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
