import { facetableFamilies, family, familyAttribute, paramForFamily, values } from '@keco/core';

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

/**
 * The families that answer "what is this and what does it solve" — §6's own framing of `kind`
 * ("what the artifact *is*") and `domains` ("what problem it solves"). The other six facetable
 * families are qualifiers: a licence class, a maturity level or an install method describes a
 * tool you already found rather than a category you would browse into.
 *
 * Naming two family *ids* is not the thing §6 warns against. The warning is about naming
 * *values* — `operator`, `observability`, `krew` — because those are the vocabulary that grows
 * and rots. Family ids are structural, and the read side already depends on exactly these two
 * (`findAlternatives` matches on `kind` plus overlapping `domains`).
 *
 * Drawing from every family instead would be worse, not more principled: `license_class` and
 * `openness` apply to nearly the whole corpus, so `permissive` and `fully-open` would outrank
 * every real category and fill the row with noise.
 */
const CATEGORY_FAMILIES = ['kind', 'domains'] as const;

/**
 * The most populated categories in the corpus, highest count first — what the zero-result
 * state offers a reader who has found nothing.
 *
 * Built from a facet distribution rather than a hardcoded list, so it cannot disagree with the
 * corpus and needs no edit when the taxonomy grows. A value with no documents renders no chip,
 * which means an empty index produces an empty array and the caller shows nothing at all.
 */
export function topCategories(
  distribution: Record<string, Record<string, number>>,
  limit = 10,
): Chip[] {
  const chips: Chip[] = [];

  for (const familyId of CATEGORY_FAMILIES) {
    const counts = distribution[familyAttribute(familyId)] ?? {};
    const param = paramForFamily(familyId);

    for (const value of values(familyId)) {
      const count = counts[value.id] ?? 0;
      if (count === 0) continue;
      chips.push({
        id: `${familyId}:${value.id}`,
        label: value.label,
        description: value.description,
        count,
        href: `/search?${param}=${encodeURIComponent(value.id)}`,
      });
    }
  }

  return chips.sort((a, b) => b.count - a.count).slice(0, limit);
}

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
