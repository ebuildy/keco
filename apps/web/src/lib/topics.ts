import { facetableFamilies, family, values } from '@keco/core';
import { familyAttribute, paramForFamily } from '@keco/query';

/**
 * Turns a Meilisearch facet distribution into the chip rows the home page renders (§9).
 * Pure, so it is unit-testable without a DOM — the .tsx component below holds no logic.
 *
 * A value with no documents behind it does not render. That keeps an empty index (which is
 * the state until the first crawl) showing nothing rather than a wall of dead links, and it
 * means a taxonomy value nobody matched is silently absent instead of a zero-count chip.
 */
export type Chip = {
  id: string;
  label: string;
  description: string;
  count: number;
  href: string;
};

export type ChipRow = {
  familyId: string;
  label: string;
  description: string;
  chips: Chip[];
  /** Set when the row was capped, so the UI can offer the full list. */
  moreHref: string | null;
};

export const DEFAULT_CHIP_LIMIT = 12;

export function chipRows(
  distribution: Record<string, Record<string, number>>,
  limit = DEFAULT_CHIP_LIMIT,
): ChipRow[] {
  const rows: ChipRow[] = [];

  for (const familyId of facetableFamilies()) {
    const counts = distribution[familyAttribute(familyId)] ?? {};
    const param = paramForFamily(familyId);

    const chips = values(familyId)
      .map((value) => ({
        id: value.id,
        label: value.label,
        description: value.description,
        count: counts[value.id] ?? 0,
        href: `/search?${param}=${encodeURIComponent(value.id)}`,
      }))
      .filter((chip) => chip.count > 0)
      .sort((a, b) => b.count - a.count);

    if (chips.length === 0) continue;

    const definition = family(familyId);
    rows.push({
      familyId,
      label: definition.label,
      description: definition.description,
      chips: chips.slice(0, limit),
      moreHref: chips.length > limit ? '/search' : null,
    });
  }

  return rows;
}
