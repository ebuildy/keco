import { createQueryClient, type QueryClient } from '@keco/query';
import type { Env } from './env';

/**
 * The read side's one Meilisearch handle (AGENTS.md §11). REST, MCP and chat are thin
 * adapters over @keco/query — a capability in one and not the others is a bug.
 *
 * The portal does not use this: it queries Meilisearch from the browser with a search-only
 * key (§9). This client holds the master key and never leaves the server.
 */
export const queryClient = (env: Env): QueryClient =>
  createQueryClient({ MEILI_HOST: env.MEILI_HOST, MEILI_MASTER_KEY: env.MEILI_MASTER_KEY });
