import { TAXONOMY, facetableFamilies, family, isValue } from '@keco/core';
// One definition of the attribute mapping, in the package that owns the index settings.
import { familyAttribute } from '@keco/search';

/**
 * Pure Meilisearch filter and facet construction (AGENTS.md §5). No client, no I/O — which
 * is what makes it testable, and what keeps `searchTools` down to one readable call.
 *
 * Everything here loops over the taxonomy rather than naming families, so adding a family
 * is a YAML edit plus a rebuild and nothing in this package changes.
 */

/** family id → selected value ids. */
export type FacetSelection = Record<string, string[]>;

export type FilterParams = {
  filters?: FacetSelection;
  /** Repository facts, not taxonomy families — open vocabularies that cannot be declared. */
  language?: string[];
  license?: string[];
  includeArchived?: boolean;
  /** Courses, blogs and dotfiles are demoted at projection; filtered out here (§14). */
  minRelevance?: number;
};

const inClause = (attribute: string, values: string[]) =>
  `${attribute} IN [${values.map((value) => `"${value}"`).join(', ')}]`;

export function buildFilters(params: FilterParams): string[] {
  const filters: string[] = [];

  for (const taxonomyFamily of TAXONOMY) {
    const selected = params.filters?.[taxonomyFamily.id];
    if (selected?.length) filters.push(inClause(familyAttribute(taxonomyFamily.id), selected));
  }

  if (params.language?.length) filters.push(inClause('language', params.language));
  if (params.license?.length) filters.push(inClause('license', params.license));

  if (!params.includeArchived) filters.push('archived = false');
  filters.push(`k8s_relevance >= ${params.minRelevance ?? 0.4}`);

  return filters;
}

/** Every facet distribution the home page and the search sidebar need, in one query. */
export const defaultFacets = (): string[] => facetableFamilies().map(familyAttribute);

type RawParams = Record<string, string | string[] | undefined>;

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : value.split(',');

/**
 * Reads a URL query object into a selection, using each family's declared `param` and
 * dropping anything not in the vocabulary — a hand-edited URL must not reach Meilisearch
 * as a filter on a value that cannot exist.
 *
 * Accepts either a Next.js `searchParams` object or a `URLSearchParams` — the portal has the
 * first, the REST route has the second, and both must read facets identically (§11).
 */
export function selectionFromParams(params: RawParams | URLSearchParams): FacetSelection {
  const read = (key: string): string | string[] | undefined =>
    params instanceof URLSearchParams ? params.getAll(key) : params[key];

  const selection: FacetSelection = {};
  for (const taxonomyFamily of TAXONOMY) {
    const values = asList(read(taxonomyFamily.param))
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value !== '' && isValue(taxonomyFamily.id, value));
    if (values.length) selection[taxonomyFamily.id] = values;
  }
  return selection;
}

/** The URL parameter a family is selected by — for building links. */
export const paramForFamily = (familyId: string): string => family(familyId).param;

// Re-exported so the portal has one import for everything facet-shaped.
export { familyAttribute };
