import type { ToolDocument } from '@keco/core';
import { getTool, searchTools, type SearchParams, type SearchResult } from '@keco/query';
import { readCache } from './cache';
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

/**
 * The slice of the cache the read side is allowed to use: two reads, by key. Injectable so
 * route tests need no `.cache` directory on disk. Nothing here can write or list — that is
 * the §2.2 contract, expressed as a type rather than a comment.
 */
export type ReadOnlyCache = {
  getText(key: string): Promise<string | null>;
  getJSON<T>(key: string): Promise<T | null>;
  /** Icons are binary; `getText` would mangle them by decoding as UTF-8. */
  getBuffer(key: string): Promise<Buffer | null>;
};

export const liveCache = (env: Env): ReadOnlyCache => readCache(env);
