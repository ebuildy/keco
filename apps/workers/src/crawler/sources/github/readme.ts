/**
 * `GET /repos/{owner}/{repo}/readme` → the two artifacts §3 names: `readme.md` verbatim and
 * `readme.json`. Pure, so the one field that matters is provable by a fixture.
 *
 * That field is `image_base_url`. Relative README image paths break unless rewritten against
 * it (AGENTS.md §14), and it is what `apps/api/src/routes/readme.ts` feeds into the `src` of
 * every image on a tool page. Its `ReadmeMetaSchema` rejects a non-https value and falls back
 * to a GitHub-derived default, so a malformed value here degrades rather than breaking — but it
 * degrades for the whole corpus, silently, which is worse than loud.
 *
 * The base is the README's own DIRECTORY, not the repo root: a README at `docs/README.md`
 * referencing `./logo.png` means `docs/logo.png`.
 */

/** The API response, as much of it as this module reads. Verbatim JSON — no schema here. */
export type ReadmeResponse = {
  path?: string;
  content?: string;
  encoding?: string;
};

export type ReadmeMeta = {
  path: string;
  branch: string;
  etag: string | null;
  image_base_url: string;
};

export type ReadmeArtifacts = {
  /** Written verbatim to `readme.md`. */
  markdown: string;
  /** Written to `readme.json`. */
  meta: ReadmeMeta;
};

export type ReadmeContext = {
  /** `owner/name`. */
  repo: string;
  branch: string;
  etag: string | null;
};

export function toReadmeArtifacts(
  response: ReadmeResponse,
  context: ReadmeContext,
): ReadmeArtifacts | null {
  const path = response.path;
  if (typeof path !== 'string' || path === '') return null;
  if (typeof response.content !== 'string') return null;
  // GitHub sends base64 for a README; anything else means a payload this code has not seen and
  // must not guess at. `none` is what the API returns for a file too large to inline.
  if (response.encoding !== 'base64') return null;

  // GitHub wraps its base64 at 60 characters. Buffer tolerates the newlines, but stripping them
  // keeps the decode independent of that formatting choice.
  const markdown = Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8');

  return {
    markdown,
    meta: {
      path,
      branch: context.branch,
      etag: context.etag,
      image_base_url: imageBaseUrl(context.repo, context.branch, path),
    },
  };
}

/**
 * Always https, always trailing-slash — the shape `apps/api`'s `defaultImageBaseUrl` produces
 * and its `ReadmeMetaSchema` validates. A missing trailing slash silently drops the last path
 * segment when `new URL(relative, base)` resolves against it.
 */
function imageBaseUrl(repo: string, branch: string, readmePath: string): string {
  const directory = readmePath.includes('/') ? readmePath.slice(0, readmePath.lastIndexOf('/') + 1) : '';
  return `https://raw.githubusercontent.com/${repo}/${branch}/${directory}`;
}
