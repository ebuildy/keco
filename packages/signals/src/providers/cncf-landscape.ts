import type { Cache } from '@keco/cache';
import type { LandscapeEntry } from '@keco/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DAY, Provider } from '../provider';

/**
 * CNCF Landscape (AGENTS.md §4.2, §6) — the seed that lets `classifyGovernance` and
 * `classifyMaturity` stop reporting `unknown` for real foundation projects (etcd-io,
 * containerd, helm, prometheus, cilium). One bulk file for the whole corpus (§4.2's "bulk over
 * per-repo" — the same shape as `brewProvider`'s `formula.json`), fetched under the fixed key
 * `all`.
 *
 * `lookupLandscape` also memoizes the built index in a module-scope variable: the TTL cache in
 * `external/` still avoids the network call, but `Cache.getJSON` still means a disk read plus a
 * `JSON.parse` of the ~0.9MB serialized envelope, and this function is called once per repo in a
 * batch run over the whole corpus. Without the in-process memo that's tens of thousands of
 * avoidable full-file parses per run for data that never changes mid-run. `--force-refresh`
 * bypasses both the TTL and the memo together, so a manual refresh is never served stale data
 * from either layer.
 *
 * The source is YAML, not JSON — the one provider in this package needing `parseBody`.
 */

const LandscapeItem = z
  .object({
    name: z.string().optional(),
    repo_url: z.string().optional(),
    /** 'graduated' | 'incubating' | 'sandbox' | 'archived' (retired) | absent (not CNCF-hosted). */
    project: z.string().optional(),
  })
  .passthrough();

const LandscapeSubcategory = z
  .object({
    items: z.array(z.object({ item: LandscapeItem.optional() }).passthrough()).optional(),
  })
  .passthrough();

const LandscapeCategoryEntry = z
  .object({
    subcategories: z
      .array(z.object({ subcategory: LandscapeSubcategory.optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/**
 * Lenient by design (`.passthrough()` at every level): the real file carries dozens of fields
 * per item this module never reads, and a schema drift there must never take the whole signal
 * down (§4.2 "degrade, never fail").
 */
export const CncfLandscapeFile = z.object({
  landscape: z
    .array(z.object({ category: LandscapeCategoryEntry.optional() }).passthrough())
    .default([]),
});
export type CncfLandscapeFile = z.infer<typeof CncfLandscapeFile>;

export const cncfLandscapeProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'cncf-landscape',
      ttlSeconds: 7 * DAY,
      timeoutMs: 30_000,
      schema: CncfLandscapeFile,
      request: () => ({
        url: 'https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml',
      }),
      parseBody: async (response) => parseYaml(await response.text()),
    },
    cache,
  );

const CNCF_LEVELS = new Set(['graduated', 'incubating', 'sandbox']);

/** Case- and trailing-slash/`.git`-insensitive, so the index key and the query key always agree. */
function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

/** `owner/repo` → its GitHub URL, normalized the same way `buildLandscapeIndex` keys its map. */
export function repoLandscapeUrl(repo: string): string {
  return normalizeRepoUrl(`https://github.com/${repo}`);
}

/**
 * One entry per repo. First occurrence wins when a project is cross-listed under more than one
 * category (containerd's `second_path`, for instance) — the CNCF level is the same claim
 * either way.
 */
export function buildLandscapeIndex(file: CncfLandscapeFile): Map<string, LandscapeEntry> {
  const index = new Map<string, LandscapeEntry>();
  for (const categoryWrap of file.landscape) {
    for (const subWrap of categoryWrap.category?.subcategories ?? []) {
      for (const itemWrap of subWrap.subcategory?.items ?? []) {
        const item = itemWrap.item;
        if (!item?.repo_url || !item.project || !CNCF_LEVELS.has(item.project)) continue;
        const key = normalizeRepoUrl(item.repo_url);
        if (!index.has(key)) {
          index.set(key, {
            cncf_level: item.project as 'graduated' | 'incubating' | 'sandbox',
            // Hosting a project at any level means the foundation now steers it via the TOC —
            // the strongest governance evidence this pipeline has (§6).
            org_type: 'foundation',
          });
        }
      }
    }
  }
  return index;
}

/**
 * In-process memo of the built index, shared across every call in this process — see the
 * module doc comment above. Populated only on a successful fetch; a failure leaves it `null`
 * so the *next* call retries the network fetch, same as before this memo existed.
 */
let memoized: Map<string, LandscapeEntry> | null = null;

/** Fetch (cached) + index + look up one repo, in a single call — what `gatherSignals` uses. */
export async function lookupLandscape(
  cache: Cache,
  repo: string,
  options: { forceRefresh?: boolean; now?: Date } = {},
): Promise<{ entry: LandscapeEntry | null; partial: boolean }> {
  if (options.forceRefresh) memoized = null; // bypass the in-process memo along with the TTL
  if (!memoized) {
    const result = await cncfLandscapeProvider(cache).fetch('all', options);
    if (!result.value) return { entry: null, partial: result.partial };
    memoized = buildLandscapeIndex(result.value);
  }
  return { entry: memoized.get(repoLandscapeUrl(repo)) ?? null, partial: false };
}

/** Test-only: clears the in-process memo so tests don't leak state into each other. */
export function resetLandscapeCacheForTests(): void {
  memoized = null;
}
