/**
 * Every key in the write model (AGENTS.md §3). Keys only — there is no index and no
 * query layer. If you find yourself wanting to search the cache, you want the journal.
 */

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

/**
 * Discovery output (design 2026-08-02). Two letter buckets keep any one directory to a few
 * thousand entries — which matters on a filesystem and matters more once this is object
 * storage, where a prefix listing is billed per request.
 *
 * Only the bucket is lowercased. The filename preserves the real casing of owner/repo,
 * because GitHub names are case-sensitive in principle. Two repos differing only by case
 * would collide on a case-insensitive filesystem; that is an accepted limitation, and
 * neither name is lost from repos-full-list.yaml.
 */
const bucketChar = (char: string | undefined): string =>
  char !== undefined && /[a-z0-9]/.test(char) ? char : '_';

export const discoveryKeys = {
  fullList: 'discovery/repos-full-list.yaml',
  hashes: 'discovery/_hashes.json',
  state: 'discovery/_state.json',
  detail(repo: string): string {
    const slash = repo.indexOf('/');
    if (slash <= 0 || slash === repo.length - 1) {
      throw new Error(`expected owner/repo, got "${repo}"`);
    }
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);
    const lower = owner.toLowerCase();
    return `discovery/${bucketChar(lower[0])}/${bucketChar(lower[1])}/repo-details-${owner}__${name}.yaml`;
  },
};
