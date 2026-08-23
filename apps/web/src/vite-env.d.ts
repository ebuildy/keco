/// <reference types="vite/client" />

/**
 * Augments Vite's ImportMetaEnv. Every VITE_-prefixed value here is inlined into the bundle at
 * build time and is public permanently (§12) — never add a secret.
 */
interface ImportMetaEnv {
  /** Search-only Meilisearch key, scoped to `tools`. */
  readonly VITE_MEILI_SEARCH_KEY?: string;
  readonly VITE_MEILI_HOST?: string;
  /** '1' enables the development mock backend. No effect outside `vite dev`. */
  readonly VITE_MOCK?: string;
}
