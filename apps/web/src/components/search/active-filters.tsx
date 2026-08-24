import type { FacetGroup } from '../../lib/facets';

/**
 * The current selection, each chip naming its family — `kind: controller`.
 *
 * The family is in the label rather than in the colour because eight facetable families cannot
 * be told apart by hue: the palette validator measured violet↔blue at ΔE 1.4 under
 * deuteranopia and 7.3 for normal vision, against a floor of 15. Accent colour here means
 * exactly one thing, "selected", which is a distinction with two values however far the
 * taxonomy grows.
 */
export function ActiveFilters({
  groups,
  onToggle,
}: {
  groups: FacetGroup[];
  onToggle: (familyId: string, value: string) => void;
}) {
  const active = groups.flatMap((group) =>
    group.options.filter((option) => option.selected).map((option) => ({ group, option })),
  );

  if (active.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-2">
      {active.map(({ group, option }) => (
        <li key={`${group.familyId}:${option.id}`}>
          <button
            type="button"
            onClick={() => onToggle(group.familyId, option.id)}
            className="inline-flex items-center gap-1.5 rounded-control border border-accent/25 bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent-text"
          >
            <span className="lowercase">{group.label}</span>: {option.label}
            <span aria-hidden="true" className="opacity-55">
              ×
            </span>
            <span className="sr-only">Remove this filter</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
