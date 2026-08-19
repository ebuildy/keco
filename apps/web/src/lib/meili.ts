import { TOOLS_INDEX, type ToolDocument } from '@keco/core';
import { Meilisearch, type Index } from 'meilisearch';

/**
 * Search is browser → Meilisearch, directly (AGENTS.md §9). No backend round-trip per
 * keystroke — that is the whole reason the search key is public.
 *
 * `VITE_`-prefixed variables are inlined into the shipped bundle at build time and are public
 * permanently (§12). The key here is search-only and scoped to `tools`; the master key lives
 * in apps/api's environment and never has that prefix.
 *
 * Built lazily rather than at module load, because `prerender/index.ts` imports this module's
 * consumers in Node, where `import.meta.env` does not exist and no query is ever issued.
 */
type ViteEnv = { VITE_MEILI_HOST?: string; VITE_MEILI_SEARCH_KEY?: string };

const viteEnv = (): ViteEnv => (import.meta as ImportMeta & { env?: ViteEnv }).env ?? {};

let client: Meilisearch | null = null;

export function searchClient(): Meilisearch {
  if (client) return client;
  const env = viteEnv();
  client = new Meilisearch({
    // `||` and not `??`: an unset variable is inlined as an empty string, not undefined.
    host: env.VITE_MEILI_HOST || 'http://localhost:7700',
    apiKey: env.VITE_MEILI_SEARCH_KEY || undefined,
  });
  return client;
}

export const toolsIndex = (): Index<ToolDocument> =>
  searchClient().index<ToolDocument>(TOOLS_INDEX);
