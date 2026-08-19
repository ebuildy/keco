import { TAXONOMY, facetableFamilies, family, isValue } from './taxonomy';

/**
 * The read-side algebra (AGENTS.md §5): pure Meilisearch filter and facet construction, plus
 * the URL-parameter mapping. No client, no I/O — which is what makes it testable, and what
 * lets it live in @keco/core where a browser bundle can reach it.
 *
 * It is here rather than in @keco/query because §9 has the portal querying Meilisearch
 * directly with the search-only key, and §7 bars a browser bundle from importing @keco/query
 * or @keco/search. The portal and the API therefore share one *algebra* even though they hold
 * different clients — and the algebra is the part that can silently drift.
 *
 * Everything loops over the taxonomy rather than naming families, so adding a family is a YAML
 * edit plus a rebuild and nothing here changes.
 */

/** The public search corpus. An alias onto `tools_<ts>` (§5). */
export const TOOLS_INDEX = 'tools';

/**
 * One filterable attribute per taxonomy family, derived from the file so that adding a family
 * is a YAML edit — never an edit here that someone forgets (§5, §6). `install_methods` is an
 * array of objects, so it filters on the nested `.method`.
 */
export const familyAttribute = (familyId: string): string =>
  familyId === 'install_methods' ? 'install_methods.method' : familyId;

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
 * dropping anything not in the vocabulary — a hand-edited URL must not reach Meilisearch as a
 * filter on a value that cannot exist.
 *
 * Accepts either a plain object or a `URLSearchParams`: the portal has the second (from
 * `useSearchParams`), the REST route has the second too, and both must read facets
 * identically (§11).
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

/**
 * The sort orders the read side offers. Kept here, not in each caller, so the portal's
 * `?sort=` and the REST API's `?sort=` cannot mean different things.
 */
export type SortKey = 'relevance' | 'stars' | 'score' | 'momentum' | 'recent';

const SORTS: Record<SortKey, string[]> = {
  relevance: [],
  stars: ['stars:desc'],
  score: ['score.total:desc'],
  momentum: ['score.momentum:desc'],
  recent: ['pushed_at:desc'],
};

/**
 * A fresh array each call. `SORTS` is a module singleton shared by the API and the portal
 * bundle, and Meilisearch clients take the sort list as a plain mutable `string[]` — handing
 * out the singleton means one caller's `.push()` reorders every later query in the process.
 */
export const sortSpec = (sort: SortKey = 'relevance'): string[] => [...SORTS[sort]];

/** Narrows untrusted input — a `?sort=` value — before it reaches Meilisearch. */
export const isSortKey = (value: string): value is SortKey => Object.hasOwn(SORTS, value);
