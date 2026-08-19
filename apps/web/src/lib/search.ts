import {
  buildFilters,
  defaultFacets,
  sortSpec,
  toDocumentId,
  type FacetSelection,
  type SortKey,
  type ToolDocument,
} from '@keco/core';
import { toolsIndex } from './meili';

/**
 * The portal's retrieval, and the counterpart to @keco/query on the API side.
 *
 * §11 says REST, MCP and chat are thin adapters over one implementation; §9 says the portal
 * queries Meilisearch directly with the search-only key, and §7 bars a browser bundle from
 * importing @keco/query. Both hold: the *algebra* — filters, facets, sorts, the URL-parameter
 * mapping — lives in @keco/core and is shared, and only the client differs. The algebra is
 * the part that can silently drift; a `.search()` call cannot.
 *
 * Every function here is one Meilisearch call. Anything that needs two belongs in a route.
 */
export type PortalSearchParams = {
  q?: string;
  filters?: FacetSelection;
  sort?: SortKey;
  page?: number;
  hitsPerPage?: number;
};

export type PortalSearchResult = {
  hits: ToolDocument[];
  total: number;
  page: number;
  facets: Record<string, Record<string, number>>;
  processingTimeMs: number;
};

export async function searchTools(params: PortalSearchParams = {}): Promise<PortalSearchResult> {
  const response = await toolsIndex().search(params.q ?? '', {
    filter: buildFilters({ filters: params.filters }),
    sort: sortSpec(params.sort),
    page: params.page ?? 1,
    hitsPerPage: params.hitsPerPage ?? 20,
    // Facet distribution is the only aggregation this system has (§5).
    facets: defaultFacets(),
  });

  return {
    hits: response.hits,
    total: response.totalHits ?? response.hits.length,
    page: response.page ?? 1,
    facets: response.facetDistribution ?? {},
    processingTimeMs: response.processingTimeMs,
  };
}

/**
 * The facet distribution for every family, with no hits: `hitsPerPage: 0` buys the counts the
 * Browse rows need and nothing else (§9).
 */
export async function browseFacets(): Promise<Record<string, Record<string, number>>> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({}),
    facets: defaultFacets(),
    hitsPerPage: 0,
  });
  return response.facetDistribution ?? {};
}

/**
 * "Momentum", never "trending this week" (§4.4). With no history there is no honest star
 * velocity, and the UI must not pretend otherwise.
 */
export async function whatsHot(limit = 12): Promise<ToolDocument[]> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({}),
    sort: sortSpec('momentum'),
    hitsPerPage: limit,
  });
  return response.hits;
}

/** `owner/repo` is the public identifier; the document id is an internal detail (§11). */
export async function getTool(fullName: string): Promise<ToolDocument | null> {
  try {
    return await toolsIndex().getDocument<ToolDocument>(toDocumentId(fullName));
  } catch {
    return null;
  }
}

/**
 * Same kind, overlapping domains, ranked by score, excluding the same owner so a monorepo
 * family does not fill the list (§9).
 */
export async function findAlternatives(tool: ToolDocument, limit = 6): Promise<ToolDocument[]> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({ filters: { kind: [tool.kind], domains: tool.domains } }),
    sort: sortSpec('score'),
    hitsPerPage: limit + 10,
  });
  return response.hits
    .filter((hit) => hit.full_name !== tool.full_name && hit.owner !== tool.owner)
    .slice(0, limit);
}
