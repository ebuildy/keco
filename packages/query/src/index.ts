import { fromDocumentId, toDocumentId, type Domain, type Kind, type ToolDocument } from '@keco/core';
import { TOOLS_ALIAS } from '@keco/search';
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
      host: env.MEILI_HOST || env.NEXT_PUBLIC_MEILI_HOST || 'http://localhost:7700',
      // Search-only key, scoped to `tools`. `||` and not `??`: an unset variable in a
      // .env file is an empty string, not undefined, and nullish coalescing would hand
      // Meilisearch an empty key.
      //
      // The master key is only ever a server-side fallback for local dev. It cannot leak
      // into a browser bundle: Next inlines NEXT_PUBLIC_* only, so on the client this
      // expression reads undefined (§12).
      apiKey: env.NEXT_PUBLIC_MEILI_SEARCH_KEY || env.MEILI_MASTER_KEY,
    }),
  };
}

const index = (client: QueryClient) => client.meili.index<ToolDocument>(client.index ?? TOOLS_ALIAS);

export type SearchParams = {
  q?: string;
  kind?: Kind[];
  domains?: Domain[];
  install?: string[];
  language?: string[];
  license?: string[];
  includeArchived?: boolean;
  /** Courses, blogs and dotfiles are demoted at projection; filtered out here (§14). */
  minRelevance?: number;
  sort?: 'relevance' | 'stars' | 'score' | 'momentum' | 'recent';
  page?: number;
  hitsPerPage?: number;
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

const SORTS: Record<NonNullable<SearchParams['sort']>, string[]> = {
  relevance: [],
  stars: ['stars:desc'],
  score: ['score.total:desc'],
  momentum: ['score.momentum:desc'],
  recent: ['pushed_at:desc'],
};

export async function searchTools(client: QueryClient, params: SearchParams = {}): Promise<SearchResult> {
  const filters: string[] = [];
  const inList = (attribute: string, values?: string[]) => {
    if (values?.length) filters.push(`${attribute} IN [${values.map((v) => `"${v}"`).join(', ')}]`);
  };

  inList('kind', params.kind);
  inList('domains', params.domains);
  inList('install_methods.method', params.install);
  inList('language', params.language);
  inList('license', params.license);
  if (!params.includeArchived) filters.push('archived = false');
  filters.push(`k8s_relevance >= ${params.minRelevance ?? 0.4}`);

  const response = await index(client).search(params.q ?? '', {
    filter: filters,
    sort: SORTS[params.sort ?? 'relevance'],
    page: params.page ?? 1,
    hitsPerPage: params.hitsPerPage ?? 20,
    // Facet distribution is the only aggregation this system has (§5).
    facets: params.facets ?? ['kind', 'domains', 'install_methods.method', 'language'],
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
    kind: [tool.kind],
    domains: tool.domains,
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
  options: { domain?: Domain; limit?: number } = {},
): Promise<ToolDocument[]> {
  const result = await searchTools(client, {
    domains: options.domain ? [options.domain] : undefined,
    sort: 'momentum',
    hitsPerPage: options.limit ?? 10,
  });
  return result.hits;
}

export { fromDocumentId, toDocumentId };
export type { ToolDocument };
