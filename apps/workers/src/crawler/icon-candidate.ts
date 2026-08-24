/**
 * Where a project's icon comes from, decided from what the crawler already has in the cache
 * (AGENTS.md §4.1, spec §2.3). Pure: no network, no storage, no clock — so every rule below
 * is provable by a fixture, which is what §13 asks of a new rule.
 *
 * Three tiers, best evidence first: a logo file the project committed, then the first real
 * image in its README, then the owner's avatar. The avatar is a weaker claim — it is the org,
 * not the project — which is why the caller records which tier won.
 */

export type IconCandidate = {
  source: 'repo-logo' | 'owner-avatar';
  url: string;
};

export type IconInputs = {
  repo: string;
  defaultBranch: string;
  avatarUrl: string | null;
  /** Paths from `tree.json`, already fetched by the crawler — so tier 1 costs no request. */
  treePaths: string[];
  /** Raw `readme.md`. Empty string when there is none. */
  readme: string;
};

/** What `sharp` can rasterise, and therefore what is worth fetching. */
const EXTENSIONS = ['svg', 'png', 'jpg', 'jpeg', 'webp'];

/**
 * Ordered best-first. `.github/` is the strongest signal — a file there was put there to be
 * the project's mark — and a bare `logo.*` at the root is next.
 */
const TREE_DIRECTORIES = ['.github', '', 'docs', 'docs/images', 'assets', 'static', 'images'];

const TREE_CANDIDATES = TREE_DIRECTORIES.flatMap((dir) =>
  EXTENSIONS.map((ext) => (dir === '' ? `logo.${ext}` : `${dir}/logo.${ext}`)),
);

/**
 * Hosts a README image may come from. Everything else is skipped rather than fetched: the
 * markdown is written by strangers, so a candidate URL is a URL this system would fetch on
 * their instruction. §8 rules homepage favicons out on exactly this ground.
 */
const ALLOWED_IMAGE_HOSTS = new Set([
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'github.com',
]);

const BADGE_HOSTS = [
  'shields.io',
  'img.shields.io',
  'badge.fury.io',
  'badgen.net',
  'codecov.io',
  'coveralls.io',
  'goreportcard.com',
  'circleci.com',
  'travis-ci.org',
  'travis-ci.com',
];

/** Every image in the README, in document order, paired with the paragraph it sits in. */
type ReadmeImage = { url: string; paragraph: number };

const IMAGE_PATTERN = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

function readmeImages(readme: string): ReadmeImage[] {
  const images: ReadmeImage[] = [];
  // A blank line separates paragraphs in markdown; a badge row is one paragraph of images.
  const paragraphs = readme.split(/\n\s*\n/);
  paragraphs.forEach((paragraph, index) => {
    for (const match of paragraph.matchAll(IMAGE_PATTERN)) {
      const url = match[1] ?? match[2];
      if (url !== undefined && url !== '') images.push({ url, paragraph: index });
    }
  });
  return images;
}

const isBadgeHost = (host: string): boolean =>
  BADGE_HOSTS.some((badge) => host === badge || host.endsWith(`.${badge}`));

const hasImageExtension = (pathname: string): boolean =>
  EXTENSIONS.some((ext) => pathname.toLowerCase().endsWith(`.${ext}`));

/**
 * Resolves a README image reference to a URL worth fetching, or `null`.
 *
 * Relative paths resolve against `raw.githubusercontent.com` the same way the README renderer
 * in `apps/api` resolves them, so what the crawler downloads is what a reader sees.
 */
function resolveReadmeImage(reference: string, rawBase: string): string | null {
  let url: URL;
  try {
    url = new URL(reference, `${rawBase}/`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!ALLOWED_IMAGE_HOSTS.has(url.hostname)) return null;
  if (isBadgeHost(url.hostname)) return null;
  // A workflow status badge is served from github.com, which is otherwise allowed.
  if (url.hostname === 'github.com' && url.pathname.includes('/actions/workflows/')) return null;
  if (!hasImageExtension(url.pathname)) return null;
  return url.toString();
}

/** GitHub serves any avatar size on request; 460 keeps the 160px derivative a downscale. */
function avatarAtSize(avatarUrl: string): string | null {
  try {
    const url = new URL(avatarUrl);
    url.searchParams.set('s', '460');
    return url.toString();
  } catch {
    return null;
  }
}

export function resolveIconCandidate(inputs: IconInputs): IconCandidate | null {
  const rawBase = `https://raw.githubusercontent.com/${inputs.repo}/${inputs.defaultBranch}`;

  const tree = new Set(inputs.treePaths);
  const fromTree = TREE_CANDIDATES.find((candidate) => tree.has(candidate));
  if (fromTree !== undefined) {
    return { source: 'repo-logo', url: `${rawBase}/${fromTree}` };
  }

  const images = readmeImages(inputs.readme);
  const perParagraph = new Map<number, number>();
  for (const image of images) {
    perParagraph.set(image.paragraph, (perParagraph.get(image.paragraph) ?? 0) + 1);
  }
  for (const image of images) {
    // Three or more images in one paragraph is a badge row, whatever the hosts are.
    if ((perParagraph.get(image.paragraph) ?? 0) >= 3) continue;
    const resolved = resolveReadmeImage(image.url, rawBase);
    if (resolved !== null) return { source: 'repo-logo', url: resolved };
  }

  if (inputs.avatarUrl === null) return null;
  const avatar = avatarAtSize(inputs.avatarUrl);
  return avatar === null ? null : { source: 'owner-avatar', url: avatar };
}
