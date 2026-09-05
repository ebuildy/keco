import { contentHash, repoKeys, type Cache } from '@keco/cache';
import type { NewEvent } from '@keco/core';
import type { Conditional } from '@keco/github';
import { updateIcon } from './icon';
import { selectManifests } from './manifests';
import { toReadmeArtifacts, type ReadmeResponse } from './readme';
import { decideSkip } from './skip';

/**
 * One repo, fetched into `repos/**` (AGENTS.md §3, §4.2). The only impure module in
 * `seeds/github/`: every decision it makes lives in `skip.ts`, `readme.ts` or `manifests.ts`.
 *
 * It owns the WRITE ORDERING, because that invariant is only testable if it lives in one
 * place:
 *
 *     artifacts → journal event → _fetch.json
 *
 * A crash between the event and `_fetch.json` re-crawls the repo next run and re-emits
 * `RepoFetched` — duplicate work, which is free and idempotent because the analyzer keys on
 * `content_hash`. The reverse order loses the event silently and the analyzer never learns the
 * repo exists. Duplicate events are safe; lost events are not.
 */

/** `repos/{owner}/{repo}/_fetch.json`. */
export type FetchMeta = {
  etags: {
    repo: string | null;
    readme: string | null;
    tree: string | null;
    releases: string | null;
  };
  fetched_at: string;
  content_hash: string;
  /** Which seed or collection first named this repo. */
  source: string;
  /** Tree paths the manifests came from — the key is the basename, so provenance lives here. */
  manifests: string[];
};

/**
 * The 304 short-circuit assumes GitHub computes the repo ETag over the whole response body,
 * `pushed_at` included — so an unchanged repo document means no push, and README, tree and
 * releases cannot have changed. This bound is the guard: if that assumption is ever wrong, an
 * entry self-heals within a month instead of going permanently stale.
 */
export const REFRESH_AFTER_DAYS = 30;

/** Releases are for cadence, not history. Ten is plenty and one page is one request. */
const RELEASES_PER_PAGE = 10;

/** A manifest is a text file. Anything this size is not one. */
const MAX_MANIFEST_BYTES = 256 * 1024;

type RepoJson = {
  owner?: { login?: string; avatar_url?: string };
  description?: string | null;
  homepage?: string | null;
  topics?: string[];
  archived?: boolean;
  fork?: boolean;
  stargazers_count?: number;
  pushed_at?: string | null;
  default_branch?: string;
  license?: { spdx_id?: string | null } | null;
};

type TreeJson = { tree?: { path?: string; type?: string }[]; truncated?: boolean };

/** Only the method this module uses — so a test needs a two-line fake, not a real client. */
export type ConditionalClient = {
  conditional<T>(
    route: string,
    params: Record<string, unknown>,
    etag: string | null,
  ): Promise<Conditional<T>>;
};

export type RepoFetchDeps = {
  cache: Cache;
  client: ConditionalClient;
  /** For raw.githubusercontent.com and icon bytes — neither costs GitHub API quota. */
  fetch: typeof globalThis.fetch;
  journal: { append(event: NewEvent): Promise<unknown> };
  now?: () => Date;
};

export type RepoFetchResult =
  | { type: 'skipped'; reason: string; requests: number; points: number }
  | {
      type: 'fetched';
      content_hash: string;
      changed: boolean;
      icon_updated: boolean;
      requests: number;
      points: number;
    };

export async function fetchRepo(
  repo: string,
  source: string,
  deps: RepoFetchDeps,
): Promise<RepoFetchResult> {
  const keys = repoKeys(repo);
  const now = (deps.now ?? (() => new Date()))();
  const [owner, name] = repo.split('/') as [string, string];

  const previous = await deps.cache.getJSON<FetchMeta>(keys.fetch);
  const usable = previous !== null && !expired(previous.fetched_at, now);
  const etags = usable ? previous.etags : { repo: null, readme: null, tree: null, releases: null };

  // A 304 costs no rate-limit quota; a 200 and a 404 both cost one point.
  let requests = 0;
  let points = 0;
  const call = async <T>(route: string, params: Record<string, unknown>, etag: string | null) => {
    requests += 1;
    const result = await deps.client.conditional<T>(route, params, etag);
    if (result.status !== 'not-modified') points += 1;
    return result;
  };

  const repoResult = await call<RepoJson>('GET /repos/{owner}/{repo}', { owner, repo: name }, etags.repo);

  if (repoResult.status === 'absent') {
    await deps.journal.append({ type: 'RepoSkipped', repo, reason: 'not-found' });
    return { type: 'skipped', reason: 'not-found', requests, points };
  }

  if (repoResult.status === 'not-modified') {
    // Nothing has been pushed since the last crawl, so the other three cannot have changed.
    // This is what makes AGENTS.md §4's weekly full sweep affordable.
    const hash = previous?.content_hash ?? '';
    await deps.journal.append({ type: 'RepoFetched', repo, content_hash: hash, changed: false });
    return { type: 'fetched', content_hash: hash, changed: false, icon_updated: false, requests, points };
  }

  const repoJson = repoResult.body;
  const decision = decideSkip(
    {
      fork: repoJson.fork === true,
      archived: repoJson.archived === true,
      stars: repoJson.stargazers_count ?? 0,
      pushed_at: repoJson.pushed_at ?? null,
    },
    now,
  );
  if (decision !== null) {
    // Decided from repo.json alone, so the three requests below are never spent.
    await deps.journal.append({ type: 'RepoSkipped', repo, reason: decision.reason });
    return { type: 'skipped', reason: decision.reason, requests, points };
  }

  const branch = repoJson.default_branch ?? 'main';

  const readmeResult = await call<ReadmeResponse>(
    'GET /repos/{owner}/{repo}/readme',
    { owner, repo: name },
    etags.readme,
  );
  const treeResult = await call<TreeJson>(
    'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    { owner, repo: name, tree_sha: branch, recursive: '1' },
    etags.tree,
  );
  const releasesResult = await call<unknown>(
    'GET /repos/{owner}/{repo}/releases',
    { owner, repo: name, per_page: RELEASES_PER_PAGE },
    etags.releases,
  );

  // ── artifacts, verbatim (§3) ───────────────────────────────────────────────
  await deps.cache.putJSON(keys.repo, repoJson);

  const readme = await writeReadme(deps.cache, keys, readmeResult, { repo, branch });
  const tree = await writeTree(deps.cache, keys, treeResult);
  if (releasesResult.status === 'modified') await deps.cache.putJSON(keys.releases, releasesResult.body);

  const treePaths = (tree?.tree ?? [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path ?? '')
    .filter((path) => path !== '');

  const manifests = await writeManifests(deps, keys, repo, branch, treePaths);
  requests += manifests.requests; // raw.githubusercontent costs no point

  const hash = contentHash({ repo: repoJson, readme, treePaths });

  // Icons are best-effort by construction: updateIcon never throws, and a repo with no usable
  // icon records why in icon.json. Icon bytes are deliberately NOT part of contentHash — a logo
  // that moves changes tree.json and so changes the hash already.
  const icon = await updateIcon(
    deps.cache,
    { repo, defaultBranch: branch, avatarUrl: repoJson.owner?.avatar_url ?? null, treePaths, readme: readme ?? '' },
    { fetch: deps.fetch, now: () => now },
  );

  const changed = previous === null || previous.content_hash !== hash;

  // ── event before _fetch.json (see the module doc) ──────────────────────────
  await deps.journal.append({ type: 'RepoFetched', repo, content_hash: hash, changed });

  await deps.cache.putJSON(keys.fetch, {
    etags: {
      repo: repoResult.etag,
      readme: readmeResult.status === 'modified' ? readmeResult.etag : etags.readme,
      tree: treeResult.status === 'modified' ? treeResult.etag : etags.tree,
      releases: releasesResult.status === 'modified' ? releasesResult.etag : etags.releases,
    },
    fetched_at: now.toISOString(),
    content_hash: hash,
    source: previous?.source ?? source,
    manifests: manifests.paths,
  } satisfies FetchMeta);

  return {
    type: 'fetched',
    content_hash: hash,
    changed,
    icon_updated: icon.source !== null,
    requests,
    points,
  };
}

function expired(fetchedAt: string, now: Date): boolean {
  const age = now.getTime() - new Date(fetchedAt).getTime();
  return !(age >= 0) || age > REFRESH_AFTER_DAYS * 86_400_000;
}

async function writeReadme(
  cache: Cache,
  keys: ReturnType<typeof repoKeys>,
  result: Conditional<ReadmeResponse>,
  context: { repo: string; branch: string },
): Promise<string | null> {
  if (result.status === 'absent') return null;
  if (result.status === 'not-modified') return cache.getText(keys.readme);

  const artifacts = toReadmeArtifacts(result.body, { ...context, etag: result.etag });
  if (artifacts === null) return null;
  await cache.putText(keys.readme, artifacts.markdown, 'text/markdown');
  await cache.putJSON(keys.readmeMeta, artifacts.meta);
  return artifacts.markdown;
}

async function writeTree(
  cache: Cache,
  keys: ReturnType<typeof repoKeys>,
  result: Conditional<TreeJson>,
): Promise<TreeJson | null> {
  if (result.status === 'absent') return null;
  if (result.status === 'not-modified') return cache.getJSON<TreeJson>(keys.tree);
  await cache.putJSON(keys.tree, result.body);
  return result.body;
}

/**
 * Manifests come from raw.githubusercontent.com, which costs no GitHub API quota. Keyed by
 * basename — only one `Chart.yaml` is ever selected, so there is nothing to collide — with the
 * tree paths that were actually written recorded in `_fetch.json` so provenance is not lost.
 */
async function writeManifests(
  deps: RepoFetchDeps,
  keys: ReturnType<typeof repoKeys>,
  repo: string,
  branch: string,
  treePaths: readonly string[],
): Promise<{ paths: string[]; requests: number }> {
  const selected = selectManifests(treePaths);
  const written: string[] = [];
  let requests = 0;

  for (const path of selected) {
    requests += 1;
    let body: string;
    try {
      const response = await deps.fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`);
      if (!response.ok) continue;
      body = await response.text();
    } catch {
      // A manifest is a nice-to-have; a fetch failure here is expected (missing file, network
      // blip) and must not abort the crawl (§4.2). A cache write failure below is a different
      // class of problem and is deliberately NOT caught here — see the note below.
      continue;
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_MANIFEST_BYTES) continue;
    // Not caught: a Storage failure here is systemic (disk full, permission error), not an
    // expected per-manifest condition, and must surface the same way every other artifact
    // write in this file does — by throwing.
    await deps.cache.putText(keys.manifest(basename(path)), body);
    written.push(path);
  }

  return { paths: written, requests };
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
