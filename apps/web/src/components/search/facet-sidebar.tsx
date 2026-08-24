import { COLLAPSE_AFTER, type FacetGroup, type FacetOption } from '../../lib/facets';
import { Kbd } from '../primitives/kbd';

/**
 * One group per facetable family with hits, from the distribution `searchTools()` already
 * returns — no second query pays for this sidebar.
 *
 * Values past COLLAPSE_AFTER fold into a `<details>`: native, keyboard-navigable, and working
 * before the bundle loads. A hand-rolled disclosure would be none of those.
 *
 * Nothing here names a taxonomy family. The vocabulary is data (§6), so a ninth family appears
 * by editing the YAML and touching no component.
 */
type Props = {
  groups: FacetGroup[];
  onToggle: (familyId: string, value: string) => void;
  onClear: () => void;
  hasSelection: boolean;
};

function Option({ option, onToggle }: { option: FacetOption; onToggle: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-2 hover:text-fg">
      <input
        type="checkbox"
        checked={option.selected}
        onChange={onToggle}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--keco-accent)]"
      />
      <span className="min-w-0 truncate" title={option.description}>
        {option.label}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-faint">
        {option.count}
      </span>
    </label>
  );
}

export function FacetSidebar({ groups, onToggle, onClear, hasSelection }: Props) {
  if (groups.length === 0) return null;

  return (
    <aside className="border-line lg:border-r lg:pr-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-fg">Filters</h2>
        {hasSelection && (
          <button type="button" onClick={onClear} className="text-[11px] text-accent-text">
            Clear all
          </button>
        )}
      </div>

      <div className="space-y-4">
        {groups.map((group) => {
          const visible = group.options.slice(0, COLLAPSE_AFTER);
          const rest = group.options.slice(COLLAPSE_AFTER);

          return (
            <fieldset key={group.familyId}>
              <legend className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
                {group.label}
              </legend>
              <div className="space-y-1">
                {visible.map((option) => (
                  <Option
                    key={option.id}
                    option={option}
                    onToggle={() => onToggle(group.familyId, option.id)}
                  />
                ))}
              </div>
              {rest.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-accent-text">
                    Show {rest.length} more
                  </summary>
                  <div className="mt-1 space-y-1">
                    {rest.map((option) => (
                      <Option
                        key={option.id}
                        option={option}
                        onToggle={() => onToggle(group.familyId, option.id)}
                      />
                    ))}
                  </div>
                </details>
              )}
            </fieldset>
          );
        })}
      </div>

      <p className="mt-5 text-[10px] leading-relaxed text-faint">
        <Kbd>↑↓</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>/</Kbd> search
      </p>
    </aside>
  );
}
