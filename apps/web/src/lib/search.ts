import {
  buildFilters,
  defaultFacets,
  sortSpec,
  toDocumentId,
  TOOLS_INDEX,
  type FacetSelection,
  type SortKey,
  type ToolDocument,
} from '@keco/core';
import { MeilisearchApiError } from 'meilisearch';
import { searchClient, toolsIndex } from './meili';

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
 *
 * `total` comes free from the same response. It is what lets the home page report corpus size
 * without a second round trip — and reporting it is not decoration: §2.7 makes eventual
 * consistency the contract, so the UI states what it actually has rather than implying the
 * index is live.
 */
export async function browseFacets(): Promise<{
  facets: Record<string, Record<string, number>>;
  total: number;
}> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({}),
    facets: defaultFacets(),
    hitsPerPage: 0,
  });
  return {
    facets: response.facetDistribution ?? {},
    total: response.totalHits ?? 0,
  };
}

export type VerifiedSuggestion = { q: string; total: number };

/**
 * Keeps only the "did you mean" candidates that genuinely return results.
 *
 * A suggestion is a claim, and an unverified one sends a reader from one dead end to another.
 * §6 refuses to list an install method that cannot be proven against a registry; the same
 * standard applies here, and the proof is cheap — one `multiSearch` covers every candidate in
 * a single round trip, with `hitsPerPage: 0` so it pays for counts and no documents.
 *
 * Verified under the reader's **current filters**, because that is the search the suggestion
 * link will actually run. Proving `ingress` has hits corpus-wide and then handing back an
 * empty page because `kind=operator` is still applied would be the exact failure this
 * function exists to prevent. When the filters are the real problem, nothing verifies, no
 * suggestions render, and the empty state's "clear filters" action is the honest route out.
 */
export async function verifySuggestions(
  candidates: string[],
  filters: FacetSelection,
): Promise<VerifiedSuggestion[]> {
  if (candidates.length === 0) return [];

  const { results } = await searchClient().multiSearch({
    queries: candidates.map((q) => ({
      indexUid: TOOLS_INDEX,
      q,
      filter: buildFilters({ filters }),
      hitsPerPage: 0,
    })),
  });

  return results
    .map((result, index) => ({
      q: candidates[index] ?? '',
      total: (result as { totalHits?: number }).totalHits ?? 0,
    }))
    .filter((suggestion) => suggestion.q !== '' && suggestion.total > 0)
    .sort((a, b) => b.total - a.total);
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

/**
 * A missing or invalid `VITE_MEILI_SEARCH_KEY` and a genuinely offline Meilisearch both
 * reject a search — but they are not the same problem, and showing the reader the same
 * "unavailable" message for both hides a build-time misconfiguration behind what looks like
 * an outage nobody can act on. Meilisearch answers a missing/invalid key with 401 and every
 * other failure some other way, so the HTTP status is the signal: a search-only key scoped to
 * `tools` (§12) never gets a 401 for any reason *other* than being absent or wrong.
 */
export function searchErrorMessage(error: unknown): string {
  if (error instanceof MeilisearchApiError && error.response.status === 401) {
    return 'Search is not configured — VITE_MEILI_SEARCH_KEY is missing or invalid. Run `mise run setup`.';
  }
  return 'Search is unavailable right now.';
}
