import { parseArgs } from 'node:util';
import { repoKeys } from '@keco/cache/keys';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';
import { updateIcon } from './icon';

/**
 * `mise run icon -- --repo owner/name` — the icon pipeline, standalone.
 *
 * The crawler is still a stub (AGENTS.md §0), so this exists to prove the pipeline works
 * against real GitHub responses before there is a crawl to run it inside. It fetches only the
 * two documents the pipeline needs, and only when they are not already cached, so running it
 * over a repo the crawler has already fetched costs no GitHub quota at all.
 */
const log = workerLogger('icon');

const { values } = parseArgs({ options: { repo: { type: 'string' } }, allowPositionals: true });

const repo = values.repo;
if (repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  log.error('usage: mise run icon -- --repo owner/name');
  process.exit(1);
}

const { cache } = createRuntime();
const keys = repoKeys(repo);

type RepoJson = { default_branch?: string; owner?: { avatar_url?: string } };
type TreeJson = { tree?: { path?: string; type?: string }[] };

/**
 * Deliberately not the `@keco/github` client: that one carries the crawler's quota governor and
 * its pacer, and borrowing them for a one-repo dev command would report misleading budget usage
 * for a crawl that is not happening. Two unconditional requests, only on a cache miss.
 */
const github = async <T>(path: string): Promise<T> => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(config.GITHUB_TOKEN ? { authorization: `Bearer ${config.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
  return (await response.json()) as T;
};

const repoJson = (await cache.getJSON<RepoJson>(keys.repo)) ?? (await github<RepoJson>(`/repos/${repo}`));
const branch = repoJson.default_branch ?? 'main';
const treeJson =
  (await cache.getJSON<TreeJson>(keys.tree)) ??
  (await github<TreeJson>(`/repos/${repo}/git/trees/${branch}?recursive=1`));
const readme = (await cache.getText(keys.readme)) ?? '';

const meta = await updateIcon(
  cache,
  {
    repo,
    defaultBranch: branch,
    avatarUrl: repoJson.owner?.avatar_url ?? null,
    treePaths: (treeJson.tree ?? []).filter((entry) => entry.type === 'blob').map((entry) => entry.path ?? ''),
    readme,
  },
  { fetch: globalThis.fetch },
);

log.info({ repo, ...meta }, meta.source === null ? 'no icon' : 'icon updated');
