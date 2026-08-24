import {
  facetableFamilies,
  family,
  familyAttribute,
  paramForFamily,
  values,
  type FacetSelection,
} from '@keco/core';

/**
 * The search sidebar's view model — the counterpart to `topics.ts`, which does the same job
 * for the home page's chip rows, and pure for the same reason: the branching lives here where
 * it can be tested without a DOM, and the .tsx holds markup only.
 *
 * No new query pays for this. `searchTools()` already asks Meilisearch for
 * `facets: defaultFacets()` and already returns the distribution; the search page simply
 * ignored it until now.
 *
 * Nothing here enumerates a taxonomy family's values — the vocabulary is data (§6), so a ninth
 * family appears in the sidebar by editing the YAML and nothing else.
 */
export type FacetOption = {
  id: string;
  label: string;
  description: string;
  count: number;
  selected: boolean;
};

export type FacetGroup = {
  familyId: string;
  label: string;
  param: string;
  options: FacetOption[];
  selectedCount: number;
};

/** Values past this are folded behind "Show N more". */
export const COLLAPSE_AFTER = 5;

export function facetGroups(
  distribution: Record<string, Record<string, number>>,
  selection: FacetSelection,
): FacetGroup[] {
  const groups: FacetGroup[] = [];

  for (const familyId of facetableFamilies()) {
    const counts = distribution[familyAttribute(familyId)] ?? {};
    const selected = selection[familyId] ?? [];

    const options = values(familyId)
      .map((value) => ({
        id: value.id,
        label: value.label,
        description: value.description,
        count: counts[value.id] ?? 0,
        selected: selected.includes(value.id),
      }))
      // A zero-count value is a dead checkbox: it can only ever produce an empty result set.
      // A *selected* zero-count value is different — it is why the set is empty, so it stays,
      // or the reader cannot see the filter they need to remove.
      .filter((option) => option.count > 0 || option.selected)
      // Selected first, so a filter never hides below the collapse threshold that it caused.
      .sort((a, b) => Number(b.selected) - Number(a.selected) || b.count - a.count);

    if (options.length === 0) continue;

    const definition = family(familyId);
    groups.push({
      familyId,
      label: definition.label,
      param: paramForFamily(familyId),
      options,
      selectedCount: selected.length,
    });
  }

  return groups;
}
