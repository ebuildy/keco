import { Link } from 'react-router';
import type { VerifiedSuggestion } from '../../lib/search';
import type { Chip as ChipModel } from '../../lib/topics';
import { Chip } from '../primitives/chip';

/**
 * Empty and zero-result states must suggest something useful (§9).
 *
 * "Useful" here means *derived from what the reader actually did*, not a generic apology, and
 * every offer is a one-click action rather than advice. Four sections, narrowing outward from
 * what they asked for to what the corpus has:
 *
 * 1. **Recovery actions** — filters are the usual culprit when a plausible query returns
 *    nothing, so dropping them while keeping the query leads; keeping the filters and clearing
 *    the query is second; starting over is the fallback. Each appears only when it applies.
 * 2. **Did you mean** — spelling corrections and term relaxations, every one *verified to
 *    return hits under the current filters* before it is rendered.
 * 3. **Popular categories** — the corpus's most populated `kind` and `domains` values, from a
 *    live facet distribution.
 * 4. A closing line explaining what the corpus is.
 *
 * Deliberately no hardcoded taxonomy values. The first version suggested `kind=operator`,
 * `domain=observability` and `install=krew` as literals, which §6 warns against — the
 * vocabulary is data, and a component that names three of its values silently rots when the
 * YAML changes. Browse already renders every family from the live facet distribution, so the
 * honest move is to send the reader there rather than to guess on its behalf.
 */
type NoResultsProps = {
  query: string;
  activeFilterCount: number;
  /** The corpus's most populated categories, from `topCategories`. Empty renders no row. */
  categories: ChipModel[];
  /**
   * Spelling and relaxation suggestions that have each been **verified to return results**
   * under the reader's current filters (`verifySuggestions`). Anything unproven never gets
   * this far, so every entry here is a promise the next click will keep.
   */
  suggestions: VerifiedSuggestion[];
  onClearFilters: () => void;
  onClearQuery: () => void;
  onSuggestion: (query: string) => void;
};

export function NoResults({
  query,
  activeFilterCount,
  categories,
  suggestions,
  onClearFilters,
  onClearQuery,
  onSuggestion,
}: NoResultsProps) {
  const hasQuery = query !== '';
  const hasFilters = activeFilterCount > 0;

  /**
   * No query and no filters means the index itself is empty — the true state of the system
   * before the first crawl, not a failed search. It must not read like a failure, and it must
   * not offer recovery actions that would do nothing.
   */
  const indexEmpty = !hasQuery && !hasFilters;

  const heading = indexEmpty
    ? 'Nothing indexed yet'
    : hasQuery
      ? `No tools match “${query}”`
      : 'No tools match these filters';

  const subheading = indexEmpty
    ? 'The corpus is built by crawling public GitHub repositories. Once the first crawl finishes, tools appear here automatically.'
    : hasQuery && hasFilters
      ? `Nothing matches that search with the ${activeFilterCount === 1 ? 'filter' : `${activeFilterCount} filters`} you have applied.`
      : hasQuery
        ? 'Nothing in the corpus matches that search.'
        : 'Those filters have no tools in common.';

  const action =
    'inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-[12.5px] font-medium transition-colors';

  return (
    <section className="flex min-h-[380px] flex-col items-center justify-center rounded-card border border-line bg-surface px-6 py-14 text-center">
      <span
        aria-hidden="true"
        className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-xl text-faint"
      >
        ⌕
      </span>

      <h2 className="max-w-[34ch] text-[19px] font-semibold tracking-tight text-fg">{heading}</h2>
      <p className="mt-2 max-w-[52ch] text-[13.5px] leading-relaxed text-muted">{subheading}</p>

      {!indexEmpty && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {/* Ordered by how likely each is to be the actual fix. */}
          {hasFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className={`${action} bg-accent text-accent-on hover:opacity-90`}
            >
              {hasQuery
                ? `Search all tools for “${query}”`
                : `Clear ${activeFilterCount === 1 ? 'the filter' : 'all filters'}`}
            </button>
          )}

          {hasQuery && hasFilters && (
            <button
              type="button"
              onClick={onClearQuery}
              className={`${action} border border-line-strong text-fg-2 hover:text-fg`}
            >
              Keep the filters, clear the search
            </button>
          )}

          {hasQuery && !hasFilters && (
            <Link to="/search" className={`${action} bg-accent text-accent-on hover:opacity-90`}>
              Browse everything instead
            </Link>
          )}
        </div>
      )}

      {/*
        Every entry was proven to return hits under the current filters before it got here, so
        this section can only ever appear when it has somewhere real to send the reader. That
        is also why it renders above the categories: a corrected spelling of what they actually
        asked for beats a popular category they did not.
      */}
      {suggestions.length > 0 && (
        <div className="mt-8 w-full border-t border-line pt-6">
          <h3 className="mb-3 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
            Did you mean
          </h3>
          <ul className="flex flex-wrap justify-center gap-2">
            {suggestions.map((suggestion) => (
              <li key={suggestion.q}>
                <button
                  type="button"
                  onClick={() => onSuggestion(suggestion.q)}
                  className="inline-flex items-baseline gap-1.5 rounded-control border border-line-strong bg-surface px-3 py-1.5 text-[13px] text-fg transition-colors hover:border-accent hover:text-accent-text"
                >
                  <span className="font-medium">{suggestion.q}</span>
                  <span className="font-mono text-[11px] tabular-nums text-faint">
                    {suggestion.total.toLocaleString('en-GB')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Renders nothing when the index is empty, which is the one case where suggesting a
          category would be a dead link. */}
      {categories.length > 0 && (
        <nav
          aria-label="Popular categories"
          className={`w-full ${suggestions.length > 0 ? 'mt-7' : 'mt-9 border-t border-line pt-6'}`}
        >
          <h3 className="mb-3 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
            Popular categories
          </h3>
          <ul className="flex flex-wrap justify-center gap-1.5">
            {categories.map((category) => (
              <li key={category.id}>
                <Chip
                  label={category.label}
                  count={category.count}
                  to={category.href}
                  title={category.description}
                />
              </li>
            ))}
          </ul>
        </nav>
      )}

      <p className="mt-7 max-w-[52ch] text-[12.5px] leading-relaxed text-faint">
        Every tool here is classified from public GitHub data and ranked by health rather than
        stars.{' '}
        <Link to="/" className="text-accent-text">
          Browse everything
        </Link>{' '}
        to see what the corpus covers.
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
    <div
      role="alert"
      className="flex min-h-[220px] flex-col items-center justify-center rounded-card border border-line bg-surface px-6 py-10 text-center"
    >
      <span
        aria-hidden="true"
        className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-bad-soft text-lg text-bad"
      >
        !
      </span>
      <p className="max-w-[52ch] text-[14px] font-medium text-fg">{message}</p>
      <p className="mt-2 max-w-[52ch] text-[12.5px] leading-relaxed text-muted">
        Search runs directly against Meilisearch from your browser, so this is a connection or
        configuration problem rather than something wrong with the corpus.
      </p>
    </div>
  );
}
