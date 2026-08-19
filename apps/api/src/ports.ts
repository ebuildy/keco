import type { ToolDocument } from '@keco/core';
import { getTool, searchTools, type SearchParams, type SearchResult } from '@keco/query';
import type { Env } from './env';
import { queryClient } from './query';

/**
 * The two seams the routes reach the outside world through, and the reason every route test
 * in apps/api runs without a Meilisearch or a `.cache` directory.
 *
 * They live here rather than in `server.ts` so the dependency arrow only ever points one way:
 * server → routes → ports. A route importing from `server.ts` closes a cycle.
 */
export type Retrieval = {
  searchTools(params: SearchParams): Promise<SearchResult>;
  getTool(fullName: string): Promise<ToolDocument | null>;
};

/** The real thing: @keco/query bound to the master-key client (§11). */
export const liveRetrieval = (env: Env): Retrieval => {
  const client = queryClient(env);
  return {
    searchTools: (params) => searchTools(client, params),
    getTool: (fullName) => getTool(client, fullName),
  };
};
