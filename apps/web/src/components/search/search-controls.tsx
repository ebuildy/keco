import { isSortKey, type SortKey } from '@keco/core';

/**
 * Sort and the list/grid toggle. Both write the URL, which §9 already declares as this page's
 * state store (`?q=&kind=&domain=&install=&sort=&view=`) — so a view is shareable and the back
 * button undoes a sort exactly like it undoes a filter.
 */
export type ViewMode = 'list' | 'grid';

export const isViewMode = (value: string): value is ViewMode =>
  value === 'list' || value === 'grid';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'score', label: 'Health' },
  { value: 'momentum', label: 'Momentum' },
  { value: 'stars', label: 'Stars' },
  { value: 'recent', label: 'Recently pushed' },
];

export function SearchControls({
  sort,
  view,
  onSort,
  onView,
}: {
  sort: SortKey;
  view: ViewMode;
  onSort: (next: SortKey) => void;
  onView: (next: ViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="sort">
        Sort results
      </label>
      <select
        id="sort"
        value={sort}
        onChange={(event) => isSortKey(event.target.value) && onSort(event.target.value)}
        className="rounded-control border border-line-strong bg-surface px-2 py-1 text-[11.5px] text-fg-2"
      >
        {SORTS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <div className="flex overflow-hidden rounded-control border border-line-strong">
        {(['list', 'grid'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={view === mode}
            onClick={() => onView(mode)}
            className={`px-2 py-1 text-[11.5px] ${
              view === mode ? 'bg-accent text-accent-on' : 'bg-surface text-muted'
            }`}
          >
            <span aria-hidden="true">{mode === 'list' ? '☰' : '▦'}</span>
            <span className="sr-only">{mode === 'list' ? 'List view' : 'Grid view'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
