import type { ToolDocument } from '@keco/core';

/**
 * The channel the prerender uses to hand a page its data (AGENTS.md §9).
 *
 * At build time `prerender/index.ts` calls `setBootstrap()` before `renderToString`, so the
 * component tree renders with real content. At runtime the same page arrives with that data
 * serialised into `window.__KECO_DATA__`, so the client's first render matches the markup it
 * is hydrating over. Any other route reads an empty object and fetches for itself.
 */
export type Bootstrap = { tool?: ToolDocument };

declare global {
  interface Window {
    __KECO_DATA__?: Bootstrap;
  }
}

/** Set only by the prerender, which is single-threaded and renders one page at a time. */
let injected: Bootstrap | null = null;

export const setBootstrap = (data: Bootstrap | null): void => {
  injected = data;
};

export function readBootstrap(): Bootstrap {
  if (injected) return injected;
  return typeof window === 'undefined' ? {} : (window.__KECO_DATA__ ?? {});
}

/**
 * The bootstrap's tool, but only for the route it was rendered for.
 *
 * `window.__KECO_DATA__` is set once by a prerendered page and never cleared — it survives
 * every later client-side navigation. `<Routes>` remounts `ToolPage` on every `/tools/:owner
 * /:repo` visit, so an initializer that trusted the bootstrap unconditionally would render
 * the *previous* prerendered tool's `<h1>`, summary and verified install commands under the
 * new URL for the first committed frame — a stale `brew install` line is the worst bug this
 * project can ship (§6). A mismatch means "not this page's data": return null and let the
 * caller fetch, exactly as it would with no bootstrap at all.
 */
export function bootstrapToolFor(fullName: string): ToolDocument | null {
  const tool = readBootstrap().tool;
  return tool && tool.full_name === fullName ? tool : null;
}
