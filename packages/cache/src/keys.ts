/**
 * Every key in the write model (AGENTS.md §3). Keys only — there is no index and no
 * query layer. If you find yourself wanting to search the cache, you want the journal.
 */

/**
 * The rendered sizes, and the only sizes `apps/api` will serve: 32 for a result card, 64 for
 * its 2× source, 160 for the tool page. Exported so the worker, the route and the portal all
 * read one list instead of three hardcoded ones drifting apart.
 */
export const ICON_SIZES = [32, 64, 160] as const;
export type IconSize = (typeof ICON_SIZES)[number];

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

/**
 * Discovery output (design 2026-08-02), namespaced per query since 2026-08-16. Two letter
 * buckets keep any one directory to a few thousand entries — which matters on a filesystem and
 * matters more once this is object storage, where a prefix listing is billed per request.
 *
 * Only the bucket is lowercased. The filename preserves the real casing of owner/repo,
 * because GitHub names are case-sensitive in principle. Two repos differing only by case
 * would collide on a case-insensitive filesystem; that is an accepted limitation, and
 * neither name is lost from repos-full-list.yaml.
 */
const bucketChar = (char: string | undefined): string =>
  char !== undefined && /[a-z0-9]/.test(char) ? char : '_';

/**
 * Long enough for any real keyword, short enough to stay inside the 255-byte name limit every
 * common filesystem enforces. A query longer than this truncates rather than failing with an
 * ENAMETOOLONG a hundred windows into a sweep.
 */
const MAX_SLUG_LENGTH = 100;

/**
 * `--query` is free text that becomes a directory name, so it is a path-traversal surface as
 * much as a naming one: `../..` must not resolve out of the cache, and `k8s/foo` must not
 * silently invent a level of hierarchy. Lowercase, collapse every run of non-alphanumerics to
 * one `-`, trim the ends, truncate; anything left with no alphanumerics at all is refused.
 *
 * The slug is deliberately lossy, so two queries CAN share one namespace — `kubernetes
 * operator` and `kubernetes-operator` both give `kubernetes-operator`. Accepted: colliding
 * queries are near-identical searches whose union is still a valid candidate corpus, the
 * artifacts stay greppable by a human reading `.cache/discovery/`, and the escape hatch is a
 * different CACHE_DIR. A disambiguating hash suffix would fix it at the cost of making every
 * directory name unguessable — a bad trade for a cache people inspect by hand.
 *
 * ASCII only: a query with no ASCII alphanumerics (`日本語`) throws rather than sweeping into a
 * namespace named after nothing.
 */
const slugifyQuery = (query: string): string => {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  if (slug === '') {
    throw new Error(
      `discovery query ${JSON.stringify(query)} has no ASCII alphanumeric characters, so it ` +
        'has no cache namespace. Pass a keyword such as --query kubernetes.',
    );
  }
  return slug;
};

/**
 * Every discovery key, for one query. A factory rather than a bare object because the query is
 * part of every one of these paths: callers slugify once, at `DiscoveryStore.open()`, and the
 * validation for a hostile query happens there — before any I/O — instead of at each key.
 *
 * Namespacing is what lets two keywords share a cache. Before it, `--query istio` opened the
 * `kubernetes` corpus's full list, hash index and state, and the only protection was a
 * runtime guard in the store; the paths simply do not overlap now.
 */
export const discoveryKeys = (query: string) => {
  const slug = slugifyQuery(query);
  return {
    fullList: `discovery/${slug}/repos-full-list.yaml`,
    hashes: `discovery/${slug}/_hashes.json`,
    state: `discovery/${slug}/_state.json`,
    detail(repo: string): string {
      const slash = repo.indexOf('/');
      if (slash <= 0 || slash === repo.length - 1 || slash !== repo.lastIndexOf('/')) {
        throw new Error(`expected owner/repo, got "${repo}"`);
      }
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      const lower = owner.toLowerCase();
      return `discovery/${slug}/${bucketChar(lower[0])}/${bucketChar(lower[1])}/repo-details-${owner}__${name}.yaml`;
    },
  };
};

export type DiscoveryKeys = ReturnType<typeof discoveryKeys>;

/**
 * Where discovery's state file sat before per-query namespacing (2026-08-02 → 2026-08-16).
 * Nothing reads or writes it: it is only a marker the worker probes so it can *say* that an
 * old cache's artifacts are now unreachable, instead of reporting an empty corpus and
 * re-sweeping for hours with no explanation. Delete once no such cache can plausibly exist.
 */
export const legacyDiscoveryStateKey = 'discovery/_state.json';
