import { DAY_SECONDS, externalGet } from '../external';
import { repoFromUrl } from './repo-url';
import type { SeedAdapter, SeedContext, SeedRef } from './types';

/**
 * Artifact Hub (AGENTS.md §4.2). Proof a chart or an operator is published, which is what makes
 * `install_methods: helm` and `operator-hub` provable rather than guessed (§6).
 *
 * OperatorHub rides on the same adapter. Scraping `k8s-operatorhub/community-operators` means
 * walking `operators/*` and reading a `*.clusterserviceversion.yaml` per operator — hundreds of
 * fetches for data Artifact Hub already indexes under its OLM kind. Same source of truth, one
 * HTTP shape, far fewer requests. Recorded in the design spec §7.2 rather than left as a silent
 * difference from AGENTS.md.
 */

const SEARCH_URL = 'https://artifacthub.io/api/v1/packages/search';

/** Artifact Hub's own cap. Asking for more returns a 400, not more results. */
export const ARTIFACTHUB_PAGE_SIZE = 60;

/**
 * A bound on one seed's cost, not on the registry's size. 20 pages is 1200 packages, comfortably
 * past the point where the tail is charts nobody installs — and a seed that pages forever turns
 * one dead provider into an unbounded loop.
 */
export const MAX_PAGES = 20;

/** Artifact Hub's package kinds. 0 is a Helm chart, 3 is an OLM operator. */
const KIND_HELM_CHART = 0;
const KIND_OLM_OPERATOR = 3;

type Package = { repository?: { url?: unknown } };

/** Pure. A restructured response yields `[]` rather than throwing (§4.2). */
export function parseArtifactHubPage(json: string): string[] {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    return [];
  }
  const packages = (document as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(packages)) return [];

  return (packages as Package[])
    .map((entry) => repoFromUrl(typeof entry?.repository?.url === 'string' ? entry.repository.url : null))
    .filter((repo): repo is string => repo !== null);
}

function artifactHubAdapter(name: string, kind: number): SeedAdapter {
  return {
    name,
    async refs(context: SeedContext): Promise<SeedRef[]> {
      const refs: SeedRef[] = [];
      const seen = new Set<string>();

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const offset = page * ARTIFACTHUB_PAGE_SIZE;
        const url =
          `${SEARCH_URL}?kind=${kind}&limit=${ARTIFACTHUB_PAGE_SIZE}&offset=${offset}` +
          '&sort=stars&facets=false';

        const result = await externalGet(
          {
            // Keyed by adapter name, not by a shared "artifacthub": one cache key for two kinds
            // would serve helm charts as operators.
            provider: name,
            key: `search-${offset}`,
            url,
            ttlSeconds: DAY_SECONDS,
            forceRefresh: context.forceRefresh,
            init: { headers: { accept: 'application/json' } },
          },
          context,
        );

        // Keep what we have rather than discarding a good page because the next one 503'd.
        if (result.body === null) break;

        const found = parseArtifactHubPage(result.body);
        for (const repo of found) {
          // Many charts ship from one monorepo — argo-helm publishes a dozen.
          if (seen.has(repo)) continue;
          seen.add(repo);
          refs.push({ repo, source: name });
        }

        // A short page is the last page. Paging past it costs a request to learn nothing.
        if (found.length < ARTIFACTHUB_PAGE_SIZE) break;
      }

      return refs;
    },
  };
}

export const artifactHubSeed = artifactHubAdapter('artifacthub', KIND_HELM_CHART);
export const operatorHubSeed = artifactHubAdapter('operatorhub', KIND_OLM_OPERATOR);
