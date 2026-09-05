import { parse } from 'yaml';
import { DAY_SECONDS, externalGet } from '../external';
import { repoFromUrl } from './repo-url';
import type { SeedAdapter, SeedContext, SeedRef } from './types';

/**
 * The krew plugin index (AGENTS.md §4.2). Proof a `kubectl` plugin is published, which is what
 * makes `install_methods: krew` provable rather than guessed (§6).
 *
 * Two hops: one GitHub tree call to learn which plugins exist, then each plugin's manifest from
 * raw.githubusercontent.com — which costs no GitHub API quota at all. Both cached for a day, so
 * a re-crawl is free and a parser fix costs no network.
 */

export const KREW_PROVIDER = 'krew';
const KREW_REPO = 'kubernetes-sigs/krew-index';
const TREE_URL = `https://api.github.com/repos/${KREW_REPO}/git/trees/master?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${KREW_REPO}/master`;

type TreeEntry = { path?: unknown; type?: unknown };

/**
 * Top-level `plugins/*.yaml` only. `plugins/nested/…` and `deprecated/…` are not plugin
 * manifests, and fetching them would be a request each to discover that.
 */
export function pluginPaths(treeJson: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(treeJson);
  } catch {
    return [];
  }
  const tree = (document as { tree?: unknown } | null)?.tree;
  if (!Array.isArray(tree)) return [];

  return (tree as TreeEntry[])
    .filter((entry) => entry?.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path as string)
    .filter((path) => /^plugins\/[^/]+\.ya?ml$/.test(path));
}

/** `spec.homepage` — the plugin's project. Returns null rather than throwing on bad YAML. */
export function parseKrewPlugin(yaml: string): string | null {
  let document: unknown;
  try {
    document = parse(yaml);
  } catch {
    return null;
  }
  const homepage = (document as { spec?: { homepage?: unknown } } | null)?.spec?.homepage;
  return typeof homepage === 'string' ? homepage : null;
}

export const krewSeed: SeedAdapter = {
  name: 'krew',
  async refs(context: SeedContext): Promise<SeedRef[]> {
    const index = await externalGet(
      {
        provider: KREW_PROVIDER,
        key: 'index',
        url: TREE_URL,
        ttlSeconds: DAY_SECONDS,
        forceRefresh: context.forceRefresh,
        init: {
          headers: {
            accept: 'application/vnd.github+json',
            // Unauthenticated api.github.com is 60 req/hour, shared with everything else on
            // this IP. One call a day is cheap; one call a day that 403s is a dead seed.
            ...(context.githubToken ? { authorization: `Bearer ${context.githubToken}` } : {}),
          },
        },
      },
      context,
    );
    if (index.body === null) return [];

    const refs: SeedRef[] = [];
    const seen = new Set<string>();

    for (const path of pluginPaths(index.body)) {
      const manifest = await externalGet(
        {
          provider: KREW_PROVIDER,
          key: path,
          url: `${RAW_BASE}/${path}`,
          ttlSeconds: DAY_SECONDS,
          forceRefresh: context.forceRefresh,
        },
        context,
      );
      if (manifest.body === null) continue;

      const repo = repoFromUrl(parseKrewPlugin(manifest.body));
      // Several plugins can ship from one repo (kubectx and kubens do).
      if (repo === null || seen.has(repo)) continue;
      seen.add(repo);
      refs.push({ repo, source: 'krew' });
    }

    return refs;
  },
};
