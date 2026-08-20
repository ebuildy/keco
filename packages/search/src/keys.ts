import type { Meilisearch } from 'meilisearch';
import { TOOLS_ALIAS } from './settings';

/**
 * The browser key AGENTS.md §12 requires: search-only, scoped to `tools`, never the master
 * key. Meilisearch mints exactly that shape through its own key API — there is no reason to
 * hand-roll a token when the store already issues scoped ones.
 *
 * Looked up by this description on every call, so re-running `mise run setup` finds the key
 * it minted last time instead of creating a new one on every run: `.env` only ever needs
 * writing once, and Meilisearch doesn't accumulate orphaned keys with every fresh clone.
 */
export const SEARCH_KEY_DESCRIPTION = 'keco portal — browser search key (search-only, tools)';

/**
 * Idempotent: finds the key this created previously, or mints a new one scoped to exactly
 * `actions: ['search']`, `indexes: [indexUid]` — never `*`, never the master key's actions.
 */
export async function ensureSearchOnlyKey(client: Meilisearch, indexUid: string = TOOLS_ALIAS): Promise<string> {
  const existing = await client.getKeys({ limit: 100 });
  const found = existing.results.find((key) => key.description === SEARCH_KEY_DESCRIPTION);
  if (found) return found.key;

  const created = await client.createKey({
    description: SEARCH_KEY_DESCRIPTION,
    actions: ['search'],
    indexes: [indexUid],
    expiresAt: null,
  });
  return created.key;
}
