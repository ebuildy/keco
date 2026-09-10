import { analysisKey, repoKeys, type Cache, type Journal } from '@keco/cache';
import { type Analysis } from '@keco/core';
import { analyzeRepo, type AnalyzeInput, type LlmDeps } from '@keco/analyze';
import { MANIFEST_FILES } from '../crawler/sources/github/manifests';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createRuntime, perItem } from '../lib/runtime';

/**
 * analyzer — `RepoFetched` where `changed` → `analysis/**` + `RepoAnalyzed` (§4.2).
 *
 * Thin by construction, the way `crawler/index.ts` is over `sources/github/fetch.ts`: every
 * classification decision lives in `@keco/analyze`'s `analyzeRepo`, this file only does the
 * I/O — reading the four cached artifacts a repo needs, writing the result, appending the
 * event, advancing the checkpoint.
 *
 * It reads the journal and its own checkpoint — never Meilisearch. An analyzer that queries a
 * read model to decide what to work on has broken the pattern (§2.1, §14).
 */
const log = workerLogger('analyzer');

export type AnalyzeOptions = {
  /** Provider name — the only TTL bypass, and it is manual. `null` honours every TTL. */
  forceRefresh: string | null;
  repo: string | null;
  minConfidence: number | null;
};

export type AnalyzerDeps = {
  cache: Cache;
  journal: Journal;
  /** `null` when no ANTHROPIC_API_KEY is configured — pass 3 degrades honestly instead of running. */
  llm: LlmDeps | null;
};

function defaultDeps(): AnalyzerDeps {
  const { cache, journal } = createRuntime();
  const llm =
    config.ANTHROPIC_API_KEY !== undefined && config.ANTHROPIC_API_KEY !== ''
      ? { apiKey: config.ANTHROPIC_API_KEY, model: config.ANALYZER_MODEL }
      : null;
  return { cache, journal, llm };
}

type RepoJson = {
  name: string;
  description: string | null;
  topics?: string[];
  language: string | null;
  archived?: boolean;
  created_at: string;
  pushed_at: string;
  license: { spdx_id: string | null } | null;
  owner: { login: string; type: 'User' | 'Organization' };
};
type TreeJson = { tree?: { path?: string; type?: string }[] };
type ReleaseJson = { published_at?: string | null };

/** Reads everything pass 1/2 need for one repo out of the write model. Never LIST — every path here is a known key (§14). */
async function loadArtifacts(
  cache: Cache,
  repo: string,
  contentHash: string,
): Promise<AnalyzeInput | null> {
  const keys = repoKeys(repo);
  const repoJson = await cache.getJSON<RepoJson>(keys.repo);
  if (repoJson === null) return null;

  const readme = (await cache.getText(keys.readme)) ?? '';
  const tree = await cache.getJSON<TreeJson>(keys.tree);
  const treePaths = (tree?.tree ?? [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path ?? '')
    .filter((path) => path !== '');

  const manifests: Record<string, string> = {};
  for (const file of MANIFEST_FILES) {
    const text = await cache.getText(keys.manifest(file));
    if (text !== null) manifests[file] = text;
  }

  const releases = await cache.getJSON<ReleaseJson[]>(keys.releases);
  const latestReleaseAt = releases?.[0]?.published_at ?? null;

  return {
    repo,
    content_hash: contentHash,
    name: repoJson.name,
    description: repoJson.description,
    topics: repoJson.topics ?? [],
    tree: treePaths,
    manifests,
    language: repoJson.language,
    readme,
    derived: {
      owner: repoJson.owner.login,
      owner_type: repoJson.owner.type,
      license_spdx: repoJson.license?.spdx_id ?? null,
      archived: repoJson.archived === true,
      created_at: repoJson.created_at,
      pushed_at: repoJson.pushed_at,
      latest_release_at: latestReleaseAt,
    },
  };
}

async function analyzeOne(
  repo: string,
  contentHash: string,
  deps: AnalyzerDeps,
  options: AnalyzeOptions,
): Promise<Analysis | null> {
  const artifacts = await loadArtifacts(deps.cache, repo, contentHash);
  if (artifacts === null) {
    // A repo the crawler never fetched is a fact about the corpus, not a silent no-op (§2's
    // "events are facts about the past") — `repos_state` and the backoffice's "skipped and
    // why" view need this on the journal, the same way the crawler emits its own RepoSkipped
    // for "nothing to work with" (crawler/sources/github/fetch.ts's `reason: 'not-found'`).
    log.warn({ repo }, 'no cached repo.json — skipping (crawl it first)');
    await deps.journal.append({ type: 'RepoSkipped', repo, reason: 'not-crawled' });
    return null;
  }

  const analysis = await analyzeRepo(artifacts, {
    cache: deps.cache,
    forceRefresh: options.forceRefresh,
    llm: deps.llm,
  });
  await deps.cache.putJSON(analysisKey(repo), analysis);
  return analysis;
}

async function recordFailure(deps: AnalyzerDeps, repo: string, error: Error): Promise<void> {
  log.warn({ repo, err: error.message }, 'analysis failed');
  await deps.journal.append({ type: 'RepoFailed', repo, phase: 'analyze', error: error.message });
}

async function recordSuccess(deps: AnalyzerDeps, repo: string, analysis: Analysis): Promise<void> {
  await deps.journal.append({
    type: 'RepoAnalyzed',
    repo,
    content_hash: analysis.content_hash,
    confidence: analysis.confidence,
    partial: analysis.partial_signals.length > 0,
  });
}

export async function runAnalyzer(
  options: AnalyzeOptions,
  deps: AnalyzerDeps = defaultDeps(),
): Promise<void> {
  const { cache, journal } = deps;

  if (options.repo !== null) {
    const repo = options.repo;
    // A direct, single-repo request bypasses the journal entirely — the same bypass shape as
    // the crawler's `--repo` (§4.2). The last content_hash the crawler recorded is what this
    // analysis gets stamped with, and the checkpoint is never touched.
    const fetchMeta = await cache.getJSON<{ content_hash: string }>(repoKeys(repo).fetch);
    if (fetchMeta === null) {
      log.error({ repo }, 'repo has never been crawled — run repo:crawl first');
      process.exitCode = 1;
      return;
    }

    const analysis = await perItem(
      repo,
      () => analyzeOne(repo, fetchMeta.content_hash, deps, options),
      (target, error) => recordFailure(deps, target, error),
    );
    if (analysis) {
      await recordSuccess(deps, repo, analysis);
      log.info({ repo, kind: analysis.kind, confidence: analysis.confidence }, 'analyzed');
    }
    return;
  }

  const checkpoint = await journal.checkpoint('analyzer');
  log.info(
    { checkpoint: checkpoint.last_event_id, forceRefresh: options.forceRefresh },
    'analyzer start',
  );

  let processed = 0;
  let lastId = checkpoint.last_event_id;
  for await (const event of journal.read({ afterId: checkpoint.last_event_id })) {
    lastId = event.id;
    if (event.type === 'RepoFetched' && event.changed) {
      log.debug({ repo: event.repo, content_hash: event.content_hash }, 'analyzing');
      const analysis = await perItem(
        event.repo,
        () => analyzeOne(event.repo, event.content_hash, deps, options),
        (repo, error) => recordFailure(deps, repo, error),
      );
      if (analysis) {
        await recordSuccess(deps, event.repo, analysis);
        processed += 1;
      }
    }

    // Advance past every event once handled — including a failure, which is itself durably
    // recorded as RepoFailed. A checkpoint tracks "have I looked at this", not "did it
    // succeed": a permanently broken repo must not block the rest of the corpus forever (§4).
    await journal.advance('analyzer', event.id);
  }

  log.info({ processed, checkpoint: lastId }, 'analyzer batch complete');
}
