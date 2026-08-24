import { family, paramForFamily, values, type ToolDocument } from '@keco/core';

/**
 * The taxonomy row under a tool's summary, as links into search — the third member of the
 * `topics.ts` / `facets.ts` family, and pure for the same reason: the branching lives here
 * where a unit test can reach it, and the .tsx holds markup only.
 *
 * A classification the reader can see is a classification they can browse: every chip is a
 * `/search?<param>=<value>` link built from the family's declared `param`, the same URL the
 * home page's chip rows and the search sidebar write, so all three agree by construction and
 * a ninth family needs no edit here.
 *
 * Two §6 rules are enforced by going through `values()` rather than reading the document
 * field directly:
 *
 * - **Labels, not ids.** The chip reads "kubectl plugin", never `kubectl-plugin`.
 * - **Hidden values never render.** `unknown` is a real answer the analyzer gives — most real
 *   foundation projects report `governance: unknown` — and rendering it as a chip would offer
 *   a link to "everything we could not classify", which is not a category anybody browses.
 *   A value that is not in the visible vocabulary produces no chip at all.
 */
export type TaxonomyLink = {
  /** `${familyId}:${valueId}` — unique across families, which `valueId` alone is not. */
  id: string;
  familyId: string;
  familyLabel: string;
  valueId: string;
  label: string;
  description: string;
  href: string;
};

/**
 * What the page shows, in reading order: what it is, what it solves, where it runs, how far
 * along it is. The other four facetable families are answered better elsewhere on the page —
 * `license_class` and `openness` by the licence fact, `install_methods` by the install tabs,
 * `governance` by nothing, because it is `unknown` for most of the corpus (§6).
 */
const DISPLAYED_FAMILIES = ['kind', 'domains', 'runtime', 'maturity'] as const;

/** A family's values on a document: one string, or a list of them. */
function assigned(tool: ToolDocument, familyId: string): string[] {
  const raw: unknown = (tool as unknown as Record<string, unknown>)[familyId];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string');
  return [];
}

export function taxonomyLinks(tool: ToolDocument): TaxonomyLink[] {
  const links: TaxonomyLink[] = [];

  for (const familyId of DISPLAYED_FAMILIES) {
    const definition = family(familyId);
    const param = paramForFamily(familyId);
    const visible = values(familyId);

    for (const valueId of assigned(tool, familyId)) {
      const value = visible.find((candidate) => candidate.id === valueId);
      if (!value) continue;

      links.push({
        id: `${familyId}:${value.id}`,
        familyId,
        familyLabel: definition.label,
        valueId: value.id,
        label: value.label,
        description: value.description,
        href: `/search?${param}=${encodeURIComponent(value.id)}`,
      });
    }
  }

  return links;
}
