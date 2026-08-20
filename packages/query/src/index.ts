import {
  TOOLS_INDEX,
  buildFilters,
  defaultFacets,
  fromDocumentId,
  sortSpec,
  toDocumentId,
  type FacetSelection,
  type SortKey,
  type ToolDocument,
} from '@keco/core';
import { Meilisearch } from 'meilisearch';

/**
 * The single retrieval implementation (AGENTS.md §11). The portal, the REST API, the MCP
 * endpoint and the chatbot are all thin adapters over these functions — a capability in
 * one and not the others is a bug.
 *
 * Read side only: nothing here writes, ever (§2.2).
 */
export type QueryClient = { meili: Meilisearch; index?: string };

export function createQueryClient(env: NodeJS.ProcessEnv = process.env): QueryClient {
  return {
    meili: new Meilisearch({
      host: env.MEILI_HOST || 'http://localhost:7700',
      // Server-side only: apps/api holds the master key, and no bundler ever sees this file.
      // The browser has its own client with a search-only key (§9, §12) — Vite inlines only
      // `VITE_`-prefixed variables, and none of them are read here.
      //
      // `||` and not `??`: an unset variable in a .env file is an empty string, not
      // undefined, and nullish coalescing would hand Meilisearch an empty key.
      apiKey: env.MEILI_MASTER_KEY,
    }),
  };
}

const index = (client: QueryClient) => client.meili.index<ToolDocument>(client.index ?? TOOLS_INDEX);

export type SearchParams = {
  q?: string;
  /**
   * Taxonomy selections, keyed by family id. Nothing in this package knows the family
   * names — they come from taxonomy.yaml (§6).
   */
  filters?: FacetSelection;
  language?: string[];
  license?: string[];
  includeArchived?: boolean;
  /** Courses, blogs and dotfiles are demoted at projection; filtered out here (§14). */
  minRelevance?: number;
  sort?: SortKey;
  page?: number;
  hitsPerPage?: number;
  /** Attributes to compute a facet distribution for. Defaults to every facetable family. */
  facets?: string[];
};

export type SearchResult = {
  hits: ToolDocument[];
  total: number;
  page: number;
  hitsPerPage: number;
  facets: Record<string, Record<string, number>>;
  processingTimeMs: number;
};

export async function searchTools(client: QueryClient, params: SearchParams = {}): Promise<SearchResult> {
  const response = await index(client).search(params.q ?? '', {
    filter: buildFilters(params),
    sort: sortSpec(params.sort),
    page: params.page ?? 1,
    hitsPerPage: params.hitsPerPage ?? 20,
    // Facet distribution is the only aggregation this system has (§5).
    facets: params.facets ?? defaultFacets(),
  });

  return {
    hits: response.hits,
    total: response.totalHits ?? response.hits.length,
    page: response.page ?? 1,
    hitsPerPage: response.hitsPerPage ?? 20,
    facets: response.facetDistribution ?? {},
    processingTimeMs: response.processingTimeMs,
  };
}

/** `owner/repo` is the public identifier — internal ids never leak (§11). */
export async function getTool(client: QueryClient, fullName: string): Promise<ToolDocument | null> {
  try {
    return await index(client).getDocument<ToolDocument>(toDocumentId(fullName));
  } catch {
    return null;
  }
}

export async function compareTools(client: QueryClient, fullNames: string[]): Promise<ToolDocument[]> {
  const documents = await Promise.all(fullNames.map((name) => getTool(client, name)));
  return documents.filter((document): document is ToolDocument => document !== null);
}

/**
 * "What else does what X does": same kind, overlapping domains, ranked by score,
 * excluding the same owner so a monorepo family does not fill the list (§9).
 */
export async function findAlternatives(
  client: QueryClient,
  fullName: string,
  limit = 10,
): Promise<ToolDocument[]> {
  const tool = await getTool(client, fullName);
  if (!tool) return [];

  const result = await searchTools(client, {
    filters: { kind: [tool.kind], domains: tool.domains },
    sort: 'score',
    hitsPerPage: limit + 10,
  });

  return result.hits
    .filter((hit) => hit.full_name !== tool.full_name && hit.owner !== tool.owner)
    .slice(0, limit);
}

/**
 * Momentum, not "trending this week" (§4.3). With no history there is no honest star
 * velocity, and the UI must not pretend otherwise.
 */
export async function whatsHot(
  client: QueryClient,
  options: { domain?: string; limit?: number } = {},
): Promise<ToolDocument[]> {
  const result = await searchTools(client, {
    filters: options.domain ? { domains: [options.domain] } : undefined,
    sort: 'momentum',
    hitsPerPage: options.limit ?? 10,
  });
  return result.hits;
}

export { fromDocumentId, toDocumentId };
export type { FacetSelection, SortKey, ToolDocument };
