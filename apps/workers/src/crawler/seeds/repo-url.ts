/**
 * A GitHub URL from a registry or a README → `owner/repo`, the only public identifier in the
 * system (AGENTS.md §11). Pure, and shared by every seed that hands back a URL — four
 * near-identical parsers is how four subtly different ones appear.
 *
 * The output is always something `RepoRef` in @keco/core accepts, because a ref that fails
 * that regex fails much later, inside `Journal.append`, halfway through a crawl.
 */

/**
 * `github.com` paths that are not repositories. The awesome-list adapter scrapes free-text
 * markdown, so without this a crawl would enumerate `sponsors/…` and `topics/…` as repos and
 * spend a request discovering each one is a 404.
 */
const RESERVED_OWNERS = new Set([
  'about', 'apps', 'collections', 'events', 'explore', 'features', 'login', 'marketplace',
  'notifications', 'orgs', 'pricing', 'pulls', 'search', 'settings', 'sponsors', 'topics',
  'trending', 'users',
]);

/** GitHub's own charset for owner and repo names — the same one `RepoRef` enforces. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function repoFromUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Exact hosts, never `endsWith`: `evil-github.com` ends in `github.com`.
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return null;

  const owner = segments[0]!;
  const name = segments[1]!.replace(/\.git$/, '');

  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  // `.` and `..` are valid against SEGMENT and are not repos.
  if (name === '.' || name === '..') return null;

  return `${owner}/${name}`;
}
