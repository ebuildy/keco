import { parse } from 'yaml';
import { DAY_SECONDS, externalGet } from '../external';
import { repoFromUrl } from './repo-url';
import type { SeedAdapter, SeedContext, SeedRef } from './types';

/**
 * The CNCF landscape (AGENTS.md §4.2). The highest-signal seed there is: every entry was put
 * there deliberately by a foundation, not matched by a keyword.
 *
 * It earns its keep twice. `landscape.yml` carries each project's maturity level, which is
 * exactly the lookup `classifyDerived` needs for `maturity` and `governance` — the reason §6
 * says governance "will report `unknown` for most real foundation projects until the CNCF
 * landscape crawler ships a cached seed". The analyzer reads the same
 * `external/cncf-landscape/*.json` envelope this seed writes; there is no second key space and
 * no derived copy to drift.
 */

export const LANDSCAPE_URL = 'https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml';

export const CNCF_PROVIDER = 'cncf-landscape';

export type LandscapeEntry = {
  repo: string;
  name: string;
  /** `graduated` | `incubating` | `sandbox`, or `null` for a landscape member that is not a
   *  CNCF project. Absence of evidence never becomes a positive claim (§6). */
  project: string | null;
};

type LandscapeItem = { name?: unknown; repo_url?: unknown; project?: unknown };
type LandscapeSubcategory = { items?: unknown };
type LandscapeCategory = { subcategories?: unknown };

/**
 * Pure. A malformed or restructured landscape yields `[]` rather than throwing: a third party
 * changing its file shape must not stop a crawl (§4.2, "degrade, never fail").
 */
export function parseLandscape(yaml: string): LandscapeEntry[] {
  let document: unknown;
  try {
    document = parse(yaml);
  } catch {
    return [];
  }

  const categories = (document as { landscape?: unknown } | null)?.landscape;
  if (!Array.isArray(categories)) return [];

  const entries: LandscapeEntry[] = [];
  const seen = new Set<string>();

  for (const category of categories as LandscapeCategory[]) {
    const subcategories = category?.subcategories;
    if (!Array.isArray(subcategories)) continue;

    for (const subcategory of subcategories as LandscapeSubcategory[]) {
      const items = subcategory?.items;
      if (!Array.isArray(items)) continue;

      for (const item of items as LandscapeItem[]) {
        const repo = repoFromUrl(typeof item?.repo_url === 'string' ? item.repo_url : null);
        // A project can appear under two categories. First wins — the same rule discovery
        // applies to a repo seen in two windows.
        if (repo === null || seen.has(repo)) continue;
        seen.add(repo);
        entries.push({
          repo,
          name: typeof item?.name === 'string' ? item.name : repo,
          project: typeof item?.project === 'string' ? item.project : null,
        });
      }
    }
  }

  return entries;
}

export const cncfSeed: SeedAdapter = {
  name: 'cncf',
  async refs(context: SeedContext): Promise<SeedRef[]> {
    const result = await externalGet(
      {
        provider: CNCF_PROVIDER,
        key: 'landscape',
        url: LANDSCAPE_URL,
        ttlSeconds: DAY_SECONDS,
        forceRefresh: context.forceRefresh,
      },
      context,
    );
    if (result.body === null) return [];
    return parseLandscape(result.body).map((entry) => ({ repo: entry.repo, source: 'cncf' }));
  },
};
