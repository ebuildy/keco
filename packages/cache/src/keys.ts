/**
 * Every key in the write model (AGENTS.md §3). Keys only — there is no index and no
 * query layer. If you find yourself wanting to search the cache, you want the journal.
 */

// The size vocabulary lives in @keco/core, not here: the portal needs it too and a browser
// bundle may not import @keco/cache (§7). This file owns the *keys*, not the sizes.
import type { IconSize } from '@keco/core';

export const repoKeys = (repo: string) => ({
  /** GitHub repo API response, verbatim. */
  repo: `repos/${repo}/repo.json`,
  /** Raw README markdown, verbatim. */
  readme: `repos/${repo}/readme.md`,
  /** { path, branch, etag, image_base_url } — image_base_url is what makes relative README images work. */
  readmeMeta: `repos/${repo}/readme.json`,
  tree: `repos/${repo}/tree.json`,
  releases: `repos/${repo}/releases.json`,
  manifest: (file: string) => `repos/${repo}/manifests/${file}`,
  manifestPrefix: `repos/${repo}/manifests/`,
  /** { etags, fetched_at, content_hash, source } */
  fetch: `repos/${repo}/_fetch.json`,
  /**
   * The icon bytes exactly as fetched — verbatim, per §3, so a bug in the resize step is
   * fixed by re-deriving from here rather than by re-crawling. Extension-less on purpose:
   * finding an extension would mean listing the prefix, which §14 forbids. `icon.json`
   * records the real content type.
   */
  iconSource: `repos/${repo}/icon.src`,
  /** Derived from `iconSource`, the way `analysis/**` is derived from `repos/**`. */
  icon: (size: IconSize) => `repos/${repo}/icon-${size}.png`,
  /** { source, source_url, content_type, bytes, etag, sizes, fetched_at, error } */
  iconMeta: `repos/${repo}/icon.json`,
});

/** Every third-party response, with its TTL. Nothing calls a provider without this in front. */
export const externalKey = (provider: string, key: string) =>
  `external/${provider}/${encodeURIComponent(key)}.json`;

export const analysisKey = (repo: string) => `analysis/${repo}.json`;

export const journalKey = (day: string, id: string) => `journal/${day}/${id}.json`;
export const journalDayPrefix = (day: string) => `journal/${day}/`;

export const checkpointKey = (consumer: string) => `checkpoints/${consumer}.json`;

/** UTC day bucket for journal keys: YYYY-MM-DD. */
export const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
