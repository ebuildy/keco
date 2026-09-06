import { DAY_SECONDS, externalGet } from '../external';
import { repoFromUrl } from './repo-url';
import type { SeedAdapter, SeedContext, SeedRef } from './types';

/**
 * Curated `awesome-*` lists (AGENTS.md §4.2). The weakest of the five seeds — a link in a
 * markdown file is not a registry entry — but it reaches tools no registry publishes, and a
 * human put every one of them there on purpose.
 *
 * §4.2 says "curated awesome-* lists" and names none, so this file names them, with a reason
 * each. That is the same pattern `TREE_DIRECTORIES` in `icon-candidate.ts` uses: adding an entry
 * is a one-line PR with a rationale, not an ad-hoc string.
 */

export type AwesomeList = {
  repo: string;
  branch: string;
  path: string;
  /** Why this list is here. An entry nobody can justify is an entry nobody can remove. */
  why: string;
};

export const AWESOME_LISTS: readonly AwesomeList[] = [
  {
    repo: 'ramitsurana/awesome-kubernetes',
    branch: 'master',
    path: 'README.md',
    why: 'The oldest and broadest Kubernetes list; reaches CLI tools no registry publishes.',
  },
  {
    repo: 'tomhuang12/awesome-k8s-resources',
    branch: 'main',
    path: 'README.md',
    why: 'Curated and actively pruned, so it skews toward tools that are still maintained.',
  },
];

export const AWESOME_PROVIDER = 'awesome';

/**
 * Markdown links `[text](url)` and bare autolinks `<url>`. Deliberately not a full markdown
 * parse: this only needs URLs, and `repoFromUrl` rejects everything that is not a repo —
 * including the badge images and `sponsors/` links every awesome list carries.
 */
const LINK_PATTERN = /\[[^\]]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?[^)]*\)|<(https?:\/\/[^>\s]+)>/gi;

export function reposFromMarkdown(markdown: string): string[] {
  const repos: string[] = [];
  const seen = new Set<string>();

  for (const match of markdown.matchAll(LINK_PATTERN)) {
    const repo = repoFromUrl(match[1] ?? match[2] ?? null);
    // A list names the same repo under two headings often enough to matter.
    if (repo === null || seen.has(repo)) continue;
    seen.add(repo);
    repos.push(repo);
  }

  return repos;
}

export const awesomeSeed: SeedAdapter = {
  name: 'awesome',
  async refs(context: SeedContext): Promise<SeedRef[]> {
    const refs: SeedRef[] = [];
    const seen = new Set<string>();

    for (const list of AWESOME_LISTS) {
      const result = await externalGet(
        {
          provider: AWESOME_PROVIDER,
          key: list.repo.replace('/', '__'),
          url: `https://raw.githubusercontent.com/${list.repo}/${list.branch}/${list.path}`,
          ttlSeconds: DAY_SECONDS,
          forceRefresh: context.forceRefresh,
        },
        context,
      );
      // One renamed default branch must not take the whole seed down.
      if (result.body === null) continue;

      for (const repo of reposFromMarkdown(result.body)) {
        if (seen.has(repo)) continue;
        seen.add(repo);
        refs.push({ repo, source: 'awesome' });
      }
    }

    return refs;
  },
};
