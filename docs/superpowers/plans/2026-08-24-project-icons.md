# Project Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tool in the corpus gets an icon — 32px beside its name in a search result, 64px beside the `<h1>` on its page — found and downloaded by the write side, served from the cache by `apps/api`.

**Architecture:** The crawler resolves a candidate (repo logo from `tree.json`, then a filtered README image, then the owner avatar), fetches it into `repos/{owner}/{repo}/icon.src` **verbatim**, and derives three PNGs (32/64/160) beside it with `sharp` — the same derived-from-raw relationship `analysis/**` has to `repos/**`, so a resize bug is fixed by re-deriving offline. The projector copies a small `icon` descriptor onto the `ToolDocument`; `apps/api` serves the PNG bytes by key; the portal renders an `<img>` when the descriptor is non-null and a deterministic monogram tile when it is not.

**Tech Stack:** TypeScript (ESM, `strict`), zod, vitest, `sharp` (new, `apps/workers` only), Fastify, React + Tailwind v4, msw, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-24-project-icons-design.md`. Read it before Task 1.

---

## Before you start

Two workers this plan touches are **stubs**, and that is expected, not a blocker:

- `apps/workers/src/crawler/index.ts` parses args, logs a warning and exits.
- `apps/workers/src/projector/index.ts` walks the journal but builds no documents.

So Tasks 3–7 build *tested modules* plus the call sites inside those stubs' TODO blocks. Task 6 adds a `mise run icon -- --repo owner/name` task so the pipeline is demonstrable end to end today. Do not "finish the crawler" along the way — that is a separate spec.

Run `mise run ci` before you start, so you know the baseline is green.

## File structure

**Create:**

| Path | Responsibility |
|---|---|
| `apps/workers/src/crawler/icon-candidate.ts` | Pure: `repo.json` + `tree.json` + README → a candidate URL, or `null`. No I/O. |
| `apps/workers/src/crawler/icon-candidate.test.ts` | Resolution tiers, host allowlist, badge filtering, badge rows. |
| `apps/workers/src/crawler/icon.ts` | The pipeline: fetch (conditional, capped) → derive with `sharp` → write cache + `icon.json`. |
| `apps/workers/src/crawler/icon.test.ts` | Fetch cap, non-image type, 304, derivation, failure path. |
| `apps/workers/src/crawler/icon-cli.ts` | `mise run icon -- --repo owner/name` entry point. |
| `apps/workers/src/projector/icon.ts` | Pure: `icon.json` → the document's `icon` descriptor or `null`. |
| `apps/workers/src/projector/icon.test.ts` | Present / missing / failed / malformed. |
| `apps/api/src/routes/icon.ts` | `GET /api/icon/:owner/:repo/:size.png` — a read of a blob, by key. |
| `apps/api/src/routes/icon.test.ts` | 200, 404, rejected size, traversal, headers. |
| `apps/web/src/lib/icon.ts` | Pure: `iconUrl()` and `monogram()`. Unit-testable, no JSX. |
| `apps/web/src/lib/icon.test.ts` | URL shape, monogram determinism. |
| `apps/web/src/components/primitives/tool-icon.tsx` | `<img>` or monogram tile, with an `onError` fallback. |

**Modify:**

| Path | Change |
|---|---|
| `packages/core/src/schemas.ts` | `IconDescriptor` + `icon` on `ToolDocument`. |
| `packages/core/src/schemas.test.ts` | Both shapes and `null`. |
| `packages/cache/src/keys.ts` | `iconSource`, `icon(size)`, `iconMeta` on `repoKeys`. |
| `packages/cache/src/keys.test.ts` | New `repoKeys` describe block. |
| `apps/workers/package.json` | `sharp` dependency, `icon` script. |
| `apps/workers/src/crawler/index.ts` | Call site inside the existing TODO. |
| `apps/workers/src/projector/index.ts` | Read `icon.json` in the TODO's document build. |
| `apps/api/src/ports.ts` | `ReadOnlyCache.getBuffer`. |
| `apps/api/src/server.ts` | Register `iconRoutes`. |
| `apps/api/src/routes/readme.test.ts` | The injected cache gains `getBuffer`. |
| `apps/api/src/server.test.ts` | Same, if it injects a cache. |
| `apps/web/src/mocks/corpus/builder.ts` | `icon: null` default. |
| `apps/web/src/mocks/corpus/curated.ts` | A spread of icon states. |
| `apps/web/src/mocks/handlers.ts` | `*/api/icon/:owner/:repo/:size.png`. |
| `apps/web/src/components/search/result-card.tsx` | 32px icon. |
| `apps/web/src/routes/tool.tsx` | 64px icon. |
| `apps/web/e2e/corpus.ts` | `ICONLESS` fixture, picked by rule. |
| `apps/web/e2e/search.e2e.ts` | Icon + monogram in results. |
| `apps/web/e2e/tool.e2e.ts` | Large icon, monogram, broken-source fallback. |
| `mise.toml` | `[tasks.icon]`. |
| `AGENTS.md` | §3 cache layout, §5 document shape. |

---

## Task 1: `icon` on `ToolDocument`

**Files:**
- Modify: `packages/core/src/schemas.ts`
- Test: `packages/core/src/schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/schemas.test.ts`, add `icon: null` to the `toolDocument` fixture object (put it directly after the `readme_excerpt` line), then append this block at the end of the file:

```ts
describe('ToolDocument.icon', () => {
  it('accepts null — most of the corpus has no icon until it is crawled', () => {
    expect(() => ToolDocument.parse({ ...toolDocument, icon: null })).not.toThrow();
  });

  it('accepts a repo logo with its provenance', () => {
    const icon = {
      source: 'repo-logo',
      source_url: 'https://raw.githubusercontent.com/cert-manager/cert-manager/HEAD/logo/logo.svg',
      fetched_at: '2026-08-24T00:00:00.000Z',
    };
    expect(ToolDocument.parse({ ...toolDocument, icon }).icon).toEqual(icon);
  });

  it('accepts an owner avatar', () => {
    const icon = {
      source: 'owner-avatar',
      source_url: 'https://avatars.githubusercontent.com/u/1234?s=460',
      fetched_at: '2026-08-24T00:00:00.000Z',
    };
    expect(() => ToolDocument.parse({ ...toolDocument, icon })).not.toThrow();
  });

  // `source` is what lets the UI and the backoffice tell a real project mark from an org
  // avatar. A free-form string would let a typo through and mean nothing downstream.
  it('rejects a source outside the two it knows', () => {
    const icon = {
      source: 'favicon',
      source_url: 'https://example.com/favicon.ico',
      fetched_at: '2026-08-24T00:00:00.000Z',
    };
    expect(() => ToolDocument.parse({ ...toolDocument, icon })).toThrow();
  });

  it('requires the field, so a projector that forgets it fails loudly', () => {
    const { icon: _omitted, ...withoutIcon } = { ...toolDocument, icon: null };
    expect(() => ToolDocument.parse(withoutIcon)).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm vitest run packages/core/src/schemas.test.ts
```

Expected: the four `icon` tests fail. `ToolDocument` strips unknown keys, so `.icon` is `undefined` rather than the object, and the "rejects a source" and "requires the field" cases do not throw.

- [ ] **Step 3: Add the schema**

In `packages/core/src/schemas.ts`, insert above `export const ToolDocument = z.object({`:

```ts
/**
 * The project's icon, or `null` when it has none — most of the corpus, until the crawler
 * reaches it. The bytes live in the cache and are served by `apps/api`; what the document
 * carries is only enough to know an icon *exists* (so no card fires a request that 404s) and
 * where the artwork came from.
 *
 * `source` is load-bearing: a real project mark and an org avatar are different claims, and
 * the backoffice has to be able to say which one a reader is looking at.
 */
export const IconDescriptor = z.object({
  source: z.enum(['repo-logo', 'owner-avatar']),
  /** Provenance — the URL the artwork was actually fetched from. */
  source_url: z.url(),
  fetched_at: z.iso.datetime(),
});
export type IconDescriptor = z.infer<typeof IconDescriptor>;
```

Then add this field to `ToolDocument`, directly after the `readme_excerpt` line:

```ts
  icon: IconDescriptor.nullable(),
```

Deliberately **not** a `filterableAttribute` (§5): this stays a document change, applied by re-projecting, with no settings change and no forced alias swap.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm vitest run packages/core/src/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck the workspace**

```bash
mise run check
```

Expected: FAIL in `apps/web` — the mock builder returns a `ToolDocument` without `icon`. That is Task 10's job and it is the right kind of failure: the schema is the contract and the compiler found every consumer. Note the errors and move on.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/src/schemas.test.ts
git commit -m "feat(core): carry an icon descriptor on ToolDocument"
```

---

## Task 2: Cache keys for the icon

**Files:**
- Modify: `packages/cache/src/keys.ts`
- Test: `packages/cache/src/keys.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/cache/src/keys.test.ts` (it currently imports only `discoveryKeys` — widen the import to `import { discoveryKeys, repoKeys } from './keys';`):

```ts
describe('repoKeys icons', () => {
  const keys = repoKeys('derailed/k9s');

  // No extension: discovering one would mean listing the prefix to see what is there, and
  // §14 forbids listing the cache. The real content type lives in icon.json.
  it('stores the fetched bytes at one fixed, extension-less key', () => {
    expect(keys.iconSource).toBe('repos/derailed/k9s/icon.src');
  });

  it('names one derived PNG per rendered size', () => {
    expect(keys.icon(32)).toBe('repos/derailed/k9s/icon-32.png');
    expect(keys.icon(64)).toBe('repos/derailed/k9s/icon-64.png');
    expect(keys.icon(160)).toBe('repos/derailed/k9s/icon-160.png');
  });

  it('keeps the metadata beside them', () => {
    expect(keys.iconMeta).toBe('repos/derailed/k9s/icon.json');
  });

  it('exports the sizes it derives, so no caller hardcodes the list', () => {
    expect(ICON_SIZES).toEqual([32, 64, 160]);
  });
});
```

Widen the import again to include `ICON_SIZES`.

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm vitest run packages/cache/src/keys.test.ts
```

Expected: FAIL — `ICON_SIZES` is not exported and `keys.iconSource` is `undefined`.

- [ ] **Step 3: Add the keys**

In `packages/cache/src/keys.ts`, above `export const repoKeys`:

```ts
/**
 * The rendered sizes, and the only sizes `apps/api` will serve: 32 for a result card, 64 for
 * its 2× source, 160 for the tool page. Exported so the worker, the route and the portal all
 * read one list instead of three hardcoded ones drifting apart.
 */
export const ICON_SIZES = [32, 64, 160] as const;
export type IconSize = (typeof ICON_SIZES)[number];
```

Then add to the object `repoKeys` returns, after the `fetch` entry:

```ts
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
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm vitest run packages/cache/src/keys.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/keys.ts packages/cache/src/keys.test.ts
git commit -m "feat(cache): key the verbatim icon source and its derived PNGs"
```

---

## Task 3: Candidate resolution (pure, no network)

**Files:**
- Create: `apps/workers/src/crawler/icon-candidate.ts`
- Test: `apps/workers/src/crawler/icon-candidate.test.ts`

This is the §13 fixture rule applied to resolution rules: every tier and every filter gets a test proving it.

- [ ] **Step 1: Write the failing tests**

Create `apps/workers/src/crawler/icon-candidate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveIconCandidate, type IconInputs } from './icon-candidate';

const inputs = (over: Partial<IconInputs> = {}): IconInputs => ({
  repo: 'acme/widget',
  defaultBranch: 'main',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42',
  treePaths: [],
  readme: '',
  ...over,
});

const RAW = 'https://raw.githubusercontent.com/acme/widget/main';

describe('resolveIconCandidate — tier 1, the file tree', () => {
  it('prefers .github/logo.svg over everything else', () => {
    const found = resolveIconCandidate(
      inputs({ treePaths: ['README.md', 'assets/logo.png', '.github/logo.svg'] }),
    );
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/.github/logo.svg` });
  });

  it('walks the tiers in order when the earlier ones are absent', () => {
    const found = resolveIconCandidate(inputs({ treePaths: ['docs/images/logo.png'] }));
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/docs/images/logo.png` });
  });

  it('ignores a logo in a directory it does not recognise', () => {
    const found = resolveIconCandidate(inputs({ treePaths: ['vendor/other/logo.png'] }));
    expect(found?.source).toBe('owner-avatar');
  });

  it('ignores a file whose extension is not an image it can rasterise', () => {
    const found = resolveIconCandidate(inputs({ treePaths: ['logo.ico'] }));
    expect(found?.source).toBe('owner-avatar');
  });

  it('resolves against the default branch, not HEAD', () => {
    const found = resolveIconCandidate(
      inputs({ defaultBranch: 'master', treePaths: ['logo.png'] }),
    );
    expect(found?.url).toBe('https://raw.githubusercontent.com/acme/widget/master/logo.png');
  });
});

describe('resolveIconCandidate — tier 2, the README', () => {
  it('takes a relative image and resolves it against the branch', () => {
    const found = resolveIconCandidate(inputs({ readme: '# Widget\n\n![logo](docs/mark.png)\n' }));
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/docs/mark.png` });
  });

  it('accepts an absolute GitHub user-content URL', () => {
    const url = 'https://user-images.githubusercontent.com/1/mark.png';
    const found = resolveIconCandidate(inputs({ readme: `![logo](${url})` }));
    expect(found).toEqual({ source: 'repo-logo', url });
  });

  // README markdown is untrusted input written by 30k strangers, and a candidate is a URL
  // this system would otherwise fetch on their instruction. §8 rules homepage favicons out
  // for exactly this reason; tier 2 must not quietly reopen it.
  it('refuses an image on any other host', () => {
    const found = resolveIconCandidate(
      inputs({ readme: '![logo](https://evil.example.com/mark.png)' }),
    );
    expect(found?.source).toBe('owner-avatar');
  });

  it('refuses a non-http scheme', () => {
    const found = resolveIconCandidate(inputs({ readme: '![logo](file:///etc/passwd)' }));
    expect(found?.source).toBe('owner-avatar');
  });

  it('skips known badge hosts', () => {
    const readme = '![build](https://img.shields.io/badge/build-passing.svg)\n\n![logo](m.png)';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/m.png`);
  });

  it('skips a workflow status badge served from github.com', () => {
    const badge = 'https://github.com/acme/widget/actions/workflows/ci.yml/badge.svg';
    const readme = `![ci](${badge})\n\n![logo](m.png)`;
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/m.png`);
  });

  // Three images in one paragraph is a badge row, whatever the hosts are.
  it('skips a badge row and takes the image after it', () => {
    const readme = '![a](a.png) ![b](b.png) ![c](c.png)\n\n![logo](mark.png)';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/mark.png`);
  });

  it('takes two images in one paragraph, which is not a badge row', () => {
    const readme = '![logo](mark.png) ![sub](sub.png)';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/mark.png`);
  });

  it('reads an HTML <img> too — plenty of READMEs centre their logo that way', () => {
    const readme = '<p align="center"><img src="docs/mark.png" width="200"></p>';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/docs/mark.png`);
  });
});

describe('resolveIconCandidate — tier 3, the owner avatar', () => {
  it('falls back to the avatar at a size that never upscales the 160px derivative', () => {
    expect(resolveIconCandidate(inputs())).toEqual({
      source: 'owner-avatar',
      url: 'https://avatars.githubusercontent.com/u/42?s=460',
    });
  });

  it('preserves an existing query string on the avatar URL', () => {
    const found = resolveIconCandidate(
      inputs({ avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4' }),
    );
    expect(found?.url).toBe('https://avatars.githubusercontent.com/u/42?v=4&s=460');
  });

  it('returns null when there is no avatar either', () => {
    expect(resolveIconCandidate(inputs({ avatarUrl: null }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm vitest run apps/workers/src/crawler/icon-candidate.test.ts
```

Expected: FAIL — `Cannot find module './icon-candidate'`.

- [ ] **Step 3: Write the implementation**

Create `apps/workers/src/crawler/icon-candidate.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm vitest run apps/workers/src/crawler/icon-candidate.test.ts
```

Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/crawler/icon-candidate.ts apps/workers/src/crawler/icon-candidate.test.ts
git commit -m "feat(crawler): resolve a project icon candidate from the cached tree and README"
```

---

## Task 4: Derive the three PNGs with `sharp`

**Files:**
- Modify: `apps/workers/package.json`
- Create: `apps/workers/src/crawler/icon.ts`
- Test: `apps/workers/src/crawler/icon.test.ts`

- [ ] **Step 1: Add the dependency**

```bash
pnpm -F @keco/workers add sharp
```

`sharp` belongs to `apps/workers` **only**. It must never be reachable from `apps/api`, `apps/web` or `apps/backoffice` — the browser rule in `eslint.config.mjs` already bars `node:*` from `apps/web/src`, and nothing in `apps/api` has cause to import it. Task 13 verifies this.

- [ ] **Step 2: Write the failing test**

Create `apps/workers/src/crawler/icon.test.ts`:

```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { deriveIconSizes } from './icon';

/** A source image of a known size, built rather than committed — no binary fixture to review. */
const square = (size: number): Promise<Buffer> =>
  sharp({
    create: { width: size, height: size, channels: 4, background: { r: 50, g: 108, b: 229, alpha: 1 } },
  })
    .png()
    .toBuffer();

const wide = (): Promise<Buffer> =>
  sharp({
    create: { width: 400, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

describe('deriveIconSizes', () => {
  it('emits one PNG per declared size', async () => {
    const derived = await deriveIconSizes(await square(460));
    expect([...derived.keys()]).toEqual([32, 64, 160]);
    for (const buffer of derived.values()) {
      expect((await sharp(buffer).metadata()).format).toBe('png');
    }
  });

  it('fits each one inside its box', async () => {
    const derived = await deriveIconSizes(await square(460));
    const metadata = await sharp(derived.get(64)!).metadata();
    expect(metadata.width).toBe(64);
    expect(metadata.height).toBe(64);
  });

  // Aspect ratio is preserved rather than padded to a square: plenty of project marks are
  // wordmarks, and the portal boxes them with `object-contain`.
  it('keeps a wide wordmark wide', async () => {
    const derived = await deriveIconSizes(await wide());
    const metadata = await sharp(derived.get(160)!).metadata();
    expect(metadata.width).toBe(160);
    expect(metadata.height).toBe(40);
  });

  it('rasterises SVG, which is what makes an untrusted logo safe to serve', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
        '<script>alert(1)</script><rect width="200" height="200" fill="#326ce5"/></svg>',
    );
    const derived = await deriveIconSizes(svg);
    const png = derived.get(160)!;
    expect((await sharp(png).metadata()).format).toBe('png');
    expect(png.includes(Buffer.from('script'))).toBe(false);
  });

  it('preserves transparency rather than flattening it onto white', async () => {
    const derived = await deriveIconSizes(await wide());
    expect((await sharp(derived.get(32)!).metadata()).hasAlpha).toBe(true);
  });

  it('throws on something that is not an image at all', async () => {
    await expect(deriveIconSizes(Buffer.from('not an image'))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
pnpm vitest run apps/workers/src/crawler/icon.test.ts
```

Expected: FAIL — `Cannot find module './icon'`.

- [ ] **Step 4: Write the implementation**

Create `apps/workers/src/crawler/icon.ts`:

```ts
import { ICON_SIZES, type IconSize } from '@keco/cache/keys';
import sharp from 'sharp';

/**
 * Derived artifacts, in the same relationship to `icon.src` that `analysis/**` has to
 * `repos/**` (spec §2.2): the fetched bytes are stored verbatim per §3, and these are
 * regenerated from them offline, so a bug here is fixed by re-deriving rather than by a
 * re-crawl.
 *
 * Rasterising also strips every active element out of an SVG, which is why the route serving
 * these needs no separate sanitiser.
 */
export async function deriveIconSizes(source: Buffer): Promise<Map<IconSize, Buffer>> {
  const derived = new Map<IconSize, Buffer>();
  for (const size of ICON_SIZES) {
    derived.set(
      size,
      await sharp(source)
        // `inside` fits without padding, so a wordmark stays a wordmark and the portal boxes
        // it with `object-contain`. Upscaling is allowed: a small committed logo is still the
        // project's real mark, and the alternative is an icon that silently ignores its size.
        .resize(size, size, { fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer(),
    );
  }
  return derived;
}
```

`apps/workers/tsconfig.json` may need no change — check that `@keco/cache/keys` resolves the way `apps/api/src/routes/readme.ts` imports it (it uses the same specifier).

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm vitest run apps/workers/src/crawler/icon.test.ts
```

Expected: PASS, 6 tests. If the SVG test fails with an unsupported-format error, `sharp`'s prebuilt binary lacks librsvg — report it rather than working around it, because tier 1 finds `.svg` first for most projects.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/package.json pnpm-lock.yaml apps/workers/src/crawler/icon.ts apps/workers/src/crawler/icon.test.ts
git commit -m "feat(crawler): derive 32/64/160 icon PNGs from the verbatim source"
```

---

## Task 5: The fetch-and-store pipeline

**Files:**
- Modify: `apps/workers/src/crawler/icon.ts`
- Test: `apps/workers/src/crawler/icon.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/workers/src/crawler/icon.test.ts`, widening the import to
`import { deriveIconSizes, updateIcon, type IconMeta } from './icon';` and adding
`import { Cache, type Storage } from '@keco/cache';` plus `import { repoKeys } from '@keco/cache/keys';`:

```ts
/** An in-memory Storage, so no test touches a `.cache` directory. */
function memoryStorage(): Storage & { keys(): string[] } {
  const files = new Map<string, Buffer>();
  return {
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => {
      files.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
    has: async (key) => files.has(key),
    list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)).sort(),
    delete: async (key) => {
      files.delete(key);
    },
    keys: () => [...files.keys()].sort(),
  };
}

const NOW = new Date('2026-08-24T12:00:00.000Z');
const KEYS = repoKeys('acme/widget');

const inputsFor = (over: Partial<Parameters<typeof updateIcon>[1]> = {}) => ({
  repo: 'acme/widget',
  defaultBranch: 'main',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42',
  treePaths: ['logo.png'],
  readme: '',
  ...over,
});

const okResponse = (body: Buffer, contentType = 'image/png', etag = '"v1"') =>
  new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': contentType, etag } });

describe('updateIcon', () => {
  it('stores the fetched bytes verbatim and writes all three derivatives', async () => {
    const storage = memoryStorage();
    const source = await square(460);
    const meta = await updateIcon(new Cache(storage), inputsFor(), {
      fetch: async () => okResponse(source),
      now: () => NOW,
    });

    expect(await storage.get(KEYS.iconSource)).toEqual(source);
    expect(storage.keys()).toContain(KEYS.icon(32));
    expect(storage.keys()).toContain(KEYS.icon(160));
    expect(meta).toMatchObject({
      source: 'repo-logo',
      source_url: 'https://raw.githubusercontent.com/acme/widget/main/logo.png',
      content_type: 'image/png',
      bytes: source.byteLength,
      etag: '"v1"',
      sizes: [32, 64, 160],
      fetched_at: NOW.toISOString(),
      error: null,
    });
  });

  it('records the metadata in the cache, so the next run can be conditional', async () => {
    const storage = memoryStorage();
    const cache = new Cache(storage);
    await updateIcon(cache, inputsFor(), { fetch: async () => okResponse(await square(200)), now: () => NOW });
    expect(await cache.getJSON<IconMeta>(KEYS.iconMeta)).toMatchObject({ etag: '"v1"' });
  });

  it('sends If-None-Match and short-circuits on 304 without re-deriving', async () => {
    const storage = memoryStorage();
    const cache = new Cache(storage);
    await updateIcon(cache, inputsFor(), { fetch: async () => okResponse(await square(200)), now: () => NOW });
    const before = await storage.get(KEYS.icon(64));

    let sentHeader: string | null = null;
    const meta = await updateIcon(cache, inputsFor(), {
      fetch: async (_url, init) => {
        sentHeader = new Headers(init?.headers).get('if-none-match');
        return new Response(null, { status: 304 });
      },
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });

    expect(sentHeader).toBe('"v1"');
    expect(meta.source).toBe('repo-logo');
    expect(await storage.get(KEYS.icon(64))).toEqual(before);
  });

  it('abandons a body over the 512 KB cap rather than truncating it', async () => {
    const storage = memoryStorage();
    const huge = Buffer.alloc(600 * 1024, 1);
    const meta = await updateIcon(new Cache(storage), inputsFor(), {
      fetch: async () => okResponse(huge, 'image/png'),
      now: () => NOW,
    });

    expect(meta.source).toBeNull();
    expect(meta.error).toMatch(/too large/i);
    expect(storage.keys()).not.toContain(KEYS.iconSource);
  });

  it('refuses a non-image content type', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => okResponse(Buffer.from('<html>'), 'text/html'),
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toMatch(/content type/i);
  });

  // Degrade, never fail (§4.2). A dead CDN must not stall a crawl.
  it('records a failed fetch instead of throwing', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toContain('ECONNRESET');
  });

  it('records a 404 without retrying it forever', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => new Response(null, { status: 404 }),
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toContain('404');
  });

  // A transient blip must not blank an icon whose bytes are still sitting in the cache.
  it('keeps a previously good icon when a later run fails', async () => {
    const cache = new Cache(memoryStorage());
    await updateIcon(cache, inputsFor(), { fetch: async () => okResponse(await square(200)), now: () => NOW });

    const meta = await updateIcon(cache, inputsFor(), {
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });

    expect(meta.source).toBe('repo-logo');
    expect(meta.sizes).toEqual([32, 64, 160]);
    expect(meta.error).toContain('500');
  });

  it('records that there was nothing to fetch when no tier matched', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor({ treePaths: [], avatarUrl: null }), {
      fetch: async () => {
        throw new Error('must not be called');
      },
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toMatch(/no candidate/i);
  });

  it('records a source that is not decodable as an image', async () => {
    const meta = await updateIcon(new Cache(memoryStorage()), inputsFor(), {
      fetch: async () => okResponse(Buffer.from('nope'), 'image/png'),
      now: () => NOW,
    });
    expect(meta.source).toBeNull();
    expect(meta.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm vitest run apps/workers/src/crawler/icon.test.ts
```

Expected: FAIL — `updateIcon` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/workers/src/crawler/icon.ts` (and widen its imports to
`import { ICON_SIZES, repoKeys, type IconSize } from '@keco/cache/keys';` plus
`import type { Cache } from '@keco/cache';` and
`import { resolveIconCandidate, type IconInputs } from './icon-candidate';`):

```ts
/** `repos/{owner}/{repo}/icon.json`. `source: null` means there is no usable icon today. */
export type IconMeta = {
  source: 'repo-logo' | 'owner-avatar' | null;
  source_url: string | null;
  content_type: string | null;
  bytes: number | null;
  etag: string | null;
  sizes: number[];
  fetched_at: string;
  /** Why the last attempt produced nothing. Kept so a known-dead URL is not retried blindly. */
  error: string | null;
};

export type IconDeps = {
  fetch: typeof globalThis.fetch;
  now?: () => Date;
};

/**
 * Bounds what one repo can pull down. Comfortably above any real logo — the largest in the
 * CNCF landscape is well under 200 KB — and small enough that 30k of them is not a surprise.
 */
const MAX_ICON_BYTES = 512 * 1024;

export async function updateIcon(
  cache: Cache,
  inputs: IconInputs,
  deps: IconDeps,
): Promise<IconMeta> {
  const keys = repoKeys(inputs.repo);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const previous = await cache.getJSON<IconMeta>(keys.iconMeta);

  /**
   * Degrade, never fail (§4.2). A previously good icon survives a later failure: its bytes are
   * still in the cache, so blanking the descriptor would hide an icon that works over a
   * transient 500.
   */
  const fail = async (error: string): Promise<IconMeta> => {
    const meta: IconMeta =
      previous && previous.source !== null
        ? { ...previous, fetched_at: now, error }
        : {
            source: null, source_url: null, content_type: null, bytes: null,
            etag: null, sizes: [], fetched_at: now, error,
          };
    await cache.putJSON(keys.iconMeta, meta);
    return meta;
  };

  const candidate = resolveIconCandidate(inputs);
  if (candidate === null) return fail('no candidate: no logo in the tree or README, and no owner avatar');

  // Conditional only when the previous success came from this same URL — a project that moved
  // its logo must not be answered with the old file's ETag.
  const conditional =
    previous?.etag != null && previous.source_url === candidate.url && previous.sizes.length > 0;

  let response: Response;
  try {
    response = await deps.fetch(candidate.url, {
      headers: conditional ? { 'if-none-match': previous.etag! } : {},
      redirect: 'follow',
    });
  } catch (error) {
    return fail(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 304 && previous) {
    const meta: IconMeta = { ...previous, fetched_at: now, error: null };
    await cache.putJSON(keys.iconMeta, meta);
    return meta;
  }
  if (!response.ok) return fail(`fetch failed: HTTP ${response.status}`);

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!contentType.startsWith('image/')) return fail(`unexpected content type: ${contentType || 'none'}`);

  const source = Buffer.from(await response.arrayBuffer());
  if (source.byteLength > MAX_ICON_BYTES) {
    // Abandoned, not truncated: half a PNG is not a smaller PNG.
    return fail(`icon too large: ${source.byteLength} bytes exceeds ${MAX_ICON_BYTES}`);
  }

  let derived: Map<IconSize, Buffer>;
  try {
    derived = await deriveIconSizes(source);
  } catch (error) {
    return fail(`could not decode image: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Verbatim first (§3), then the derivatives, then the metadata that makes them findable.
  // Every put is atomic, so a crash mid-sequence leaves earlier files complete and the meta
  // absent — which the next run treats as "no icon yet" and simply redoes.
  await cache.putText(keys.iconSource, source.toString('binary'), contentType);
  await Promise.all([...derived].map(([size, png]) => cache.putText(keys.icon(size), png.toString('binary'), 'image/png')));

  const meta: IconMeta = {
    source: candidate.source,
    source_url: candidate.url,
    content_type: contentType,
    bytes: source.byteLength,
    etag: response.headers.get('etag'),
    sizes: [...ICON_SIZES],
    fetched_at: now,
    error: null,
  };
  await cache.putJSON(keys.iconMeta, meta);
  return meta;
}
```

**Note on the two `putText` calls above:** `Cache` exposes `getText`/`putText`/`getJSON`/`putJSON` but no binary pair, and `toString('binary')` round-trips lossily. Fix it properly rather than working around it — add to `packages/cache/src/storage.ts`, inside `class Cache`:

```ts
  async getBuffer(key: string): Promise<Buffer | null> {
    return this.storage.get(key);
  }

  /** Binary blobs — icons today. `putText` would corrupt them: it encodes as UTF-8. */
  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.storage.put(key, body, contentType);
  }
```

then use `cache.putBuffer(...)` in both places above.

- [ ] **Step 4: Cover the new Cache methods**

Add to `packages/cache/src/adapters/fs.test.ts` (it already builds a `FsStorage` over a temp
directory — follow whatever setup that file uses):

```ts
it('round-trips binary through putBuffer/getBuffer without mangling it', async () => {
  const cache = new Cache(storage);
  // High bytes that are not valid UTF-8: putText would replace them with U+FFFD.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
  await cache.putBuffer('repos/acme/widget/icon-32.png', bytes, 'image/png');
  expect(await cache.getBuffer('repos/acme/widget/icon-32.png')).toEqual(bytes);
});

it('returns null from getBuffer for a key that is not there', async () => {
  expect(await new Cache(storage).getBuffer('repos/acme/widget/icon-160.png')).toBeNull();
});
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
pnpm vitest run apps/workers/src/crawler/icon.test.ts packages/cache
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cache/src apps/workers/src/crawler/icon.ts apps/workers/src/crawler/icon.test.ts
git commit -m "feat(crawler): fetch icons conditionally into the cache and derive them"
```

---

## Task 6: The crawler call site and a way to run it today

**Files:**
- Modify: `apps/workers/src/crawler/index.ts`
- Create: `apps/workers/src/crawler/icon-cli.ts`
- Modify: `apps/workers/package.json`, `mise.toml`

The crawler is a stub, so the call site cannot be exercised by running it. The CLI is what makes the pipeline demonstrable end to end before the crawler lands (spec §3).

- [ ] **Step 1: Write the CLI**

Create `apps/workers/src/crawler/icon-cli.ts`:

```ts
import { parseArgs } from 'node:util';
import { repoKeys } from '@keco/cache/keys';
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

const github = async <T>(path: string): Promise<T> => {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
```

- [ ] **Step 2: Wire the scripts**

Add to `apps/workers/package.json`'s `scripts`:

```json
    "icon": "tsx src/crawler/icon-cli.ts",
```

Add to `mise.toml`, next to the other worker tasks:

```toml
[tasks.icon]
description = "Fetch and derive one repo's icon, standalone. Args: --repo owner/name"
run = "pnpm -F @keco/workers icon"
```

- [ ] **Step 3: Run it against a real repository**

```bash
mise run icon -- --repo derailed/k9s
ls .cache/repos/derailed/k9s/
```

Expected: the log reports `icon updated` with a `source`, and the directory lists `icon.src`, `icon-32.png`, `icon-64.png`, `icon-160.png` and `icon.json`. Open `icon-160.png` and look at it — this is the one step in the plan a test cannot do for you.

```bash
mise run icon -- --repo derailed/k9s
```

Run it a second time. Expected: it completes without re-deriving (the 304 path), which you can confirm from the unchanged mtimes on the PNGs.

- [ ] **Step 4: Wire the call site into the crawler**

In `apps/workers/src/crawler/index.ts`, extend the numbered TODO list — replace step 4 with:

```
  //   4. write repo.json / readme.md / readme.json / tree.json / releases.json / manifests
  //      verbatim, compute contentHash(), write _fetch.json, emit RepoFetched.
  //   5. icons — call updateIcon() from ./icon with the repo.json, tree.json and readme.md
  //      just written (spec 2026-08-24-project-icons §2.3). It never throws: a repo with no
  //      usable icon records why in icon.json and the crawl carries on. Icon bytes are
  //      deliberately NOT part of contentHash() — a logo that moves changes tree.json and so
  //      changes the hash already, and folding the bytes in would invalidate the whole corpus
  //      for a cosmetic field (§2.4 of the spec).
```

- [ ] **Step 5: Check and commit**

```bash
mise run check && mise run lint
```

Expected: `check` still fails only in `apps/web` (Task 1's known break); `lint` passes.

```bash
git add apps/workers/src/crawler/icon-cli.ts apps/workers/src/crawler/index.ts apps/workers/package.json mise.toml
git commit -m "feat(crawler): add a standalone icon task and the crawler call site"
```

---

## Task 7: The projector's icon descriptor

**Files:**
- Create: `apps/workers/src/projector/icon.ts`
- Test: `apps/workers/src/projector/icon.test.ts`
- Modify: `apps/workers/src/projector/index.ts`

The projector builds no documents yet, so this is the pure function its TODO will call, tested on its own.

- [ ] **Step 1: Write the failing test**

Create `apps/workers/src/projector/icon.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { iconDescriptor } from './icon';

const good = {
  source: 'repo-logo',
  source_url: 'https://raw.githubusercontent.com/acme/widget/main/logo.png',
  content_type: 'image/png',
  bytes: 4096,
  etag: '"v1"',
  sizes: [32, 64, 160],
  fetched_at: '2026-08-24T00:00:00.000Z',
  error: null,
};

describe('iconDescriptor', () => {
  it('carries source, provenance and freshness onto the document', () => {
    expect(iconDescriptor(good)).toEqual({
      source: 'repo-logo',
      source_url: good.source_url,
      fetched_at: good.fetched_at,
    });
  });

  it('is null when the repo has no icon.json at all', () => {
    expect(iconDescriptor(null)).toBeNull();
  });

  it('is null when the last attempt found nothing', () => {
    expect(iconDescriptor({ ...good, source: null, source_url: null, sizes: [] })).toBeNull();
  });

  // A transient failure over a still-cached icon keeps the descriptor: the bytes are there.
  it('keeps the descriptor when an error sits on top of a good icon', () => {
    expect(iconDescriptor({ ...good, error: 'fetch failed: HTTP 500' })?.source).toBe('repo-logo');
  });

  // Nothing downstream would catch a malformed descriptor: Meilisearch accepts any value and
  // the portal renders it verbatim. The write side is what guarantees read-model correctness.
  it('is null when the metadata is malformed rather than passing it through', () => {
    expect(iconDescriptor({ ...good, source: 'favicon' })).toBeNull();
    expect(iconDescriptor({ ...good, source_url: 'not a url' })).toBeNull();
    expect(iconDescriptor({ nonsense: true })).toBeNull();
  });

  it('is null when the derivatives were never written', () => {
    expect(iconDescriptor({ ...good, sizes: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm vitest run apps/workers/src/projector/icon.test.ts
```

Expected: FAIL — `Cannot find module './icon'`.

- [ ] **Step 3: Write the implementation**

Create `apps/workers/src/projector/icon.ts`:

```ts
import { IconDescriptor } from '@keco/core';

/**
 * `icon.json` → the `icon` field of a `ToolDocument`, or `null`.
 *
 * Validated rather than cast. The taxonomy lesson in the projector's own TODO applies here:
 * Meilisearch accepts any value, `searchTools` does not parse the response, and the portal
 * renders what it is given — so a malformed descriptor becomes a broken image for every
 * reader, and nothing downstream would notice. The write side is what guarantees read-model
 * correctness (§2).
 *
 * `error` is deliberately not a disqualifier: a transient failure recorded on top of an icon
 * whose bytes are still cached must not blank it.
 */
export function iconDescriptor(meta: unknown): IconDescriptor | null {
  if (meta === null || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  if (!Array.isArray(record.sizes) || record.sizes.length === 0) return null;

  const parsed = IconDescriptor.safeParse({
    source: record.source,
    source_url: record.source_url,
    fetched_at: record.fetched_at,
  });
  return parsed.success ? parsed.data : null;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm vitest run apps/workers/src/projector/icon.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Note it in the projector's TODO**

In `apps/workers/src/projector/index.ts`, inside the `TODO(projector)` block, after the sentence ending "it only scores.", add:

```
    // The icon comes from repos/{repo}/icon.json through iconDescriptor() in ./icon — a
    // descriptor or null, never a guess. It is not a filterableAttribute, so adding it needs
    // no settings change and no alias swap: re-projecting from cache is the whole migration.
```

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/projector/icon.ts apps/workers/src/projector/icon.test.ts apps/workers/src/projector/index.ts
git commit -m "feat(projector): validate icon.json into the document's icon descriptor"
```

---

## Task 8: `GET /api/icon/:owner/:repo/:size.png`

**Files:**
- Modify: `apps/api/src/ports.ts`, `apps/api/src/server.ts`
- Create: `apps/api/src/routes/icon.ts`
- Test: `apps/api/src/routes/icon.test.ts`
- Modify: `apps/api/src/routes/readme.test.ts`, `apps/api/src/routes/admin.test.ts`, `apps/api/src/routes/commands.test.ts`, `apps/api/src/plugins/static.test.ts`

- [ ] **Step 1: Widen the read-only cache port**

`ReadOnlyCache` has `getText` and `getJSON` only, and icons are binary. In `apps/api/src/ports.ts`, add to the `ReadOnlyCache` type:

```ts
  /** Icons are binary; `getText` would mangle them by decoding as UTF-8. */
  getBuffer(key: string): Promise<Buffer | null>;
```

`liveCache` needs no change — `Cache` gained `getBuffer` in Task 5. Every test that injects a cache now fails to typecheck; that is the point of the port. Add `getBuffer: async () => null,` to each of:

- `apps/api/src/plugins/static.test.ts:36`
- `apps/api/src/routes/commands.test.ts:20`
- `apps/api/src/routes/admin.test.ts:24`, `:96`, `:125`
- `apps/api/src/routes/readme.test.ts:49` (in the `buildTestApp` cache literal)

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/icon.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { build } from '../server';

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });

/** A real, tiny PNG — the route must not care what is in it, only that it is served verbatim. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwynn6HwAE2gKDj5MdkgAAAABJRU5ErkJggg==',
  'base64',
);

const files: Record<string, Buffer> = {
  'repos/derailed/k9s/icon-32.png': PNG,
  'repos/derailed/k9s/icon-64.png': PNG,
  'repos/derailed/k9s/icon-160.png': PNG,
};

const app = await build({
  env,
  retrieval: {
    searchTools: async () => {
      throw new Error('unused');
    },
    getTool: async () => null,
  },
  cache: {
    getText: async () => null,
    getJSON: async () => null,
    getBuffer: async (key: string) => files[key] ?? null,
  },
});

afterAll(() => app.close());

describe('GET /api/icon/:owner/:repo/:size.png', () => {
  it('serves the derived PNG for each declared size', async () => {
    for (const size of [32, 64, 160]) {
      const response = await app.inject({ method: 'GET', url: `/api/icon/derailed/k9s/${size}.png` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload).toEqual(PNG);
    }
  });

  /**
   * An SVG logo is rasterised to PNG before it is ever stored, so nothing active reaches a
   * reader. These headers are the belt to that braces: `nosniff` stops a browser deciding the
   * bytes are markup, and the CSP means a document served from here can load nothing.
   */
  it('serves with nosniff and a CSP that permits nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/icon/derailed/k9s/64.png' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'");
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
  });

  // An uncrawled repo is a miss, not an error. The portal already knows from the document
  // whether an icon exists, so this path is rare by construction.
  it('404s for a repo with no icon in the cache', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/icon/acme/widget/64.png' });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a size it does not derive', async () => {
    for (const size of ['128', '0', '1024']) {
      const response = await app.inject({ method: 'GET', url: `/api/icon/derailed/k9s/${size}.png` });
      expect(response.statusCode).toBe(400);
    }
  });

  // The cache key is built from path parameters, so this is a traversal surface.
  it('refuses owner and repo names GitHub could not issue', async () => {
    const urls = [
      '/api/icon/..%2f..%2fetc/passwd/64.png',
      '/api/icon/-bad/repo/64.png',
      '/api/icon/owner/re%2Fpo/64.png',
    ];
    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).not.toBe(200);
    }
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
pnpm vitest run apps/api/src/routes/icon.test.ts
```

Expected: FAIL — every request 404s, because no such route is registered.

- [ ] **Step 4: Write the route**

Create `apps/api/src/routes/icon.ts`:

```ts
import rateLimit from '@fastify/rate-limit';
import { ICON_SIZES, repoKeys } from '@keco/cache/keys';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ReadOnlyCache } from '../ports';

/**
 * The icon bytes come from the cache, never from the index — same shape as the README route
 * (AGENTS.md §9): a read of an immutable blob, by key. Never a write, never a list (§2.2, §14).
 *
 * The cache key is built from path parameters, so the vocabulary is pinned to what GitHub can
 * actually issue as an owner or a repository name, and the size to the three the projector
 * derives. Without both, `..%2f..%2f` reads arbitrary blobs.
 */
const Params = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  size: z.enum(ICON_SIZES.map(String) as [string, ...string[]]),
});

/**
 * Ten times the README route's budget, deliberately. That route runs a markdown pipeline
 * measured at up to 1.4s of blocking CPU per hit; this one reads a few KB by key and writes
 * them to the socket. One tool page pulls one icon, one search page pulls up to twenty, and a
 * reader clicking through the corpus must not trip a limiter over static bytes.
 */
const ICON_RATE_LIMIT = { max: 300, timeWindow: '1 minute' } as const;

export const iconRoutes: FastifyPluginAsync<{ cache: ReadOnlyCache }> = async (app, options) => {
  const { cache } = options;

  await app.register(rateLimit, ICON_RATE_LIMIT);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 429) return reply.code(status).send({ error: 'rate_limited', message: error.message });
    request.log.error({ err: error }, 'unhandled error in icon route');
    return reply.code(500).send({ error: 'internal_error' });
  });

  app.get<{ Params: { owner: string; repo: string; size: string } }>(
    '/:owner/:repo/:size.png',
    async (request, reply) => {
      const parsed = Params.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

      const { owner, repo, size } = parsed.data;
      const keys = repoKeys(`${owner}/${repo}`);
      const png = await cache.getBuffer(keys.icon(Number(size) as (typeof ICON_SIZES)[number]));

      // An uncrawled repo is a miss, not an error: most of the corpus has no icon yet.
      if (png === null) return reply.code(404).send({ error: 'not_found' });

      return reply
        .header('content-type', 'image/png')
        // Immutable-ish: the projector rewrites these only when the upstream ETag changes, and
        // a day-stale icon is not a claim about anything.
        .header('cache-control', 'public, max-age=86400')
        // The bytes are always a PNG the worker rasterised, never the fetched source. These
        // two make that true for a browser as well as for us.
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        .send(png);
    },
  );
};
```

**Fastify note:** `'/:owner/:repo/:size.png'` uses a parametric segment with a static `.png` suffix, which `find-my-way` supports. If the router rejects the pattern, fall back to `'/:owner/:repo/:file'` and parse `size` off `:file` with `/^(\d+)\.png$/` — keep the zod enum either way. Do not drop the `.png` from the URL: it is what makes the response obviously an image to a proxy and to a reader who lands on the URL directly.

- [ ] **Step 5: Register it**

In `apps/api/src/server.ts`, import `iconRoutes` and register it beside the README route, before the static plugin:

```ts
  await app.register(iconRoutes, { prefix: '/api/icon', cache });
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
pnpm vitest run apps/api
```

Expected: PASS across the whole `apps/api` suite, including the tests you added `getBuffer` to.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): serve derived icon PNGs from the cache by key"
```

---

## Task 9: The portal's icon primitive

**Files:**
- Create: `apps/web/src/lib/icon.ts`, `apps/web/src/lib/icon.test.ts`
- Create: `apps/web/src/components/primitives/tool-icon.tsx`

Logic goes in `src/lib` because that is where the portal's unit tests live; the component stays thin, and the e2e tests in Tasks 11–12 cover it in a DOM.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/icon.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { iconUrl, monogram } from './icon';

describe('iconUrl', () => {
  it('points at the API route for the requested size', () => {
    expect(iconUrl('derailed/k9s', 32)).toBe('/api/icon/derailed/k9s/32.png');
    expect(iconUrl('derailed/k9s', 160)).toBe('/api/icon/derailed/k9s/160.png');
  });
});

describe('monogram', () => {
  it('uses the first letter of the repository name, uppercased', () => {
    expect(monogram('derailed/k9s').letter).toBe('K');
    expect(monogram('argoproj/argo-cd').letter).toBe('A');
  });

  // The tile must not change colour between a result card and the tool page, or between two
  // visits — it reads as a stable stand-in for a logo, not as a state.
  it('derives a stable hue from the full name', () => {
    expect(monogram('derailed/k9s').hue).toBe(monogram('derailed/k9s').hue);
    expect(monogram('derailed/k9s').hue).not.toBe(monogram('helm/helm').hue);
  });

  it('keeps the hue in range', () => {
    for (const name of ['a/b', 'derailed/k9s', 'kubernetes-sigs/kustomize', 'x/' + 'y'.repeat(80)]) {
      const { hue } = monogram(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('falls back to a placeholder rather than throwing on a nameless entry', () => {
    expect(monogram('').letter).toBe('?');
  });

  it('skips a leading non-letter so the tile is never a dash', () => {
    expect(monogram('foo/-bar').letter).toBe('B');
    expect(monogram('foo/2048').letter).toBe('2');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm vitest run apps/web/src/lib/icon.test.ts
```

Expected: FAIL — `Cannot find module './icon'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/icon.ts`:

```ts
/**
 * Icons on the read side.
 *
 * The bytes live in the cache, which a browser cannot read, so they arrive through
 * `apps/api` — the same arrangement as the README (AGENTS.md §9). Whether an icon exists at
 * all is known from the document's `icon` descriptor, so a repo without one never fires a
 * request that 404s.
 */

/** The sizes `apps/api` serves. Anything else is a 400, so keep this in step with ICON_SIZES. */
export type IconSize = 32 | 64 | 160;

export const iconUrl = (fullName: string, size: IconSize): string =>
  `/api/icon/${fullName}/${size}.png`;

/**
 * The placeholder for a repo with no icon: its initial on a tile whose hue is derived from
 * its name.
 *
 * The hue is decorative and carries no meaning — it is not a category and it is not a state,
 * so it stays clear of §9's rule that colour encodes state. What it does carry is stability:
 * the same repo gets the same tile on every surface and every visit, which is what makes it
 * read as a stand-in for a logo rather than as a signal.
 */
export function monogram(fullName: string): { letter: string; hue: number } {
  const name = fullName.slice(fullName.indexOf('/') + 1);
  const letter = [...name].find((character) => /[a-z0-9]/i.test(character))?.toUpperCase() ?? '?';

  // FNV-1a: a few lines, no dependency, and well spread for short strings.
  let hash = 0x811c9dc5;
  for (let index = 0; index < fullName.length; index += 1) {
    hash ^= fullName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return { letter, hue: Math.abs(hash) % 360 };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm vitest run apps/web/src/lib/icon.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Write the component**

Create `apps/web/src/components/primitives/tool-icon.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { ToolDocument } from '@keco/core';
import { iconUrl, monogram, type IconSize } from '../../lib/icon';

/**
 * A project's icon, or a monogram tile standing in for one.
 *
 * The document says whether an icon exists, so the common case — a repo the crawler has not
 * reached — costs no request at all. `onError` still falls back, because the document and the
 * cache are two systems and eventual consistency is the contract (§2.7): a document projected
 * before its icon landed must render a placeholder, never a broken-image glyph.
 *
 * Decorative by design: `alt=""` and `aria-hidden`, because the repository's name sits
 * immediately beside it on both surfaces and a screen reader announcing it twice is noise.
 */
type Props = {
  tool: Pick<ToolDocument, 'full_name' | 'icon'>;
  /** The source to request. The rendered box is set by `className`. */
  size: IconSize;
  className?: string;
};

export function ToolIcon({ tool, size, className = '' }: Props) {
  const [failed, setFailed] = useState(false);

  // A client navigation swaps the tool without remounting; without this, one broken icon
  // would blank the next repo's.
  useEffect(() => setFailed(false), [tool.full_name]);

  const box = `shrink-0 overflow-hidden rounded-[6px] ${className}`;

  if (tool.icon === null || failed) {
    const { letter, hue } = monogram(tool.full_name);
    return (
      <span
        aria-hidden="true"
        // Decorative, so neither branch has a role or a name to match on. This is the seam the
        // e2e tests locate them by — see e2e/search.e2e.ts.
        data-icon="monogram"
        className={`${box} grid place-items-center border border-line font-semibold text-white`}
        // Inline because the hue is per-repo data, not a design token: there is no finite set
        // of utilities to generate. Fixed lightness and saturation keep every tile legible in
        // both themes, which is why this pair is not read from theme.css.
        style={{ backgroundColor: `hsl(${hue} 45% 42%)`, fontSize: '0.5em' }}
      >
        {letter}
      </span>
    );
  }

  return (
    <img
      src={iconUrl(tool.full_name, size)}
      srcSet={size === 32 ? `${iconUrl(tool.full_name, 32)} 1x, ${iconUrl(tool.full_name, 64)} 2x` : undefined}
      alt=""
      aria-hidden="true"
      data-icon="image"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`${box} bg-surface object-contain`}
    />
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/icon.ts apps/web/src/lib/icon.test.ts apps/web/src/components/primitives/tool-icon.tsx
git commit -m "feat(web): add the tool icon primitive and its monogram fallback"
```

---

## Task 10: Icons in the mock backend

**Files:**
- Modify: `apps/web/src/mocks/corpus/builder.ts`, `apps/web/src/mocks/corpus/curated.ts`, `apps/web/src/mocks/handlers.ts`
- Test: `apps/web/src/mocks/handlers.test.ts`

This must land before Tasks 11–12: MSW runs with `onUnhandledRequest: 'error'`, so the first `<img>` pointing at `/api/icon/…` fails every e2e test until a handler exists.

- [ ] **Step 1: Fix the type break from Task 1**

In `apps/web/src/mocks/corpus/builder.ts`, add to the returned object, after the `readme_excerpt` line:

```ts
    // Most of the corpus has no icon until the crawler reaches it; curated.ts overrides the
    // handful that exercise the other states.
    icon: null,
```

```bash
mise run check
```

Expected: PASS now, across the whole workspace — this closes Task 1's known break.

- [ ] **Step 2: Give the curated fixtures a spread of icon states**

In `apps/web/src/mocks/corpus/curated.ts`, add an `icon` to three entries — a repo logo, an owner avatar, and leave the rest `null` so the monogram path stays reachable:

```ts
// derailed/k9s — add inside its makeTool({ ... }) call:
    icon: {
      source: 'repo-logo',
      source_url: 'https://raw.githubusercontent.com/derailed/k9s/master/assets/k9s.png',
      fetched_at: '2026-08-24T00:00:00.000Z',
    },
```

```ts
// ahmetb/kubectx — add inside its makeTool({ ... }) call:
    icon: {
      source: 'repo-logo',
      source_url: 'https://raw.githubusercontent.com/ahmetb/kubectx/master/img/logo.png',
      fetched_at: '2026-08-24T00:00:00.000Z',
    },
```

```ts
// cert-manager/cert-manager — add inside its makeTool({ ... }) call:
    icon: {
      source: 'owner-avatar',
      source_url: 'https://avatars.githubusercontent.com/u/40632127?s=460',
      fetched_at: '2026-08-24T00:00:00.000Z',
    },
```

`source_url` is provenance, and these are the real URLs. The bytes the mock serves are a
placeholder square (Step 3) — a mock corpus already declares itself fabricated in every
document's `discovery_source`, and a decorative square is not the kind of claim §14 exists to
prevent. An invented `brew install` line is; a placeholder pixel is not.

- [ ] **Step 3: Serve icon bytes from the mock**

In `apps/web/src/mocks/handlers.ts`, add above the readme handler:

```ts
/**
 * A real 1×1 PNG in the accent blue, scaled up by the browser into a solid tile.
 *
 * Development and test only, like everything in this directory. It is deliberately not a
 * fabricated *logo*: the portal's contract is that an icon is the project's own mark, and a
 * mock that invented plausible artwork would teach the wrong thing to anyone reading it.
 * A flat square reads as a placeholder at a glance.
 */
const MOCK_ICON_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwynn6HwAE2gKDj5MdkgAAAABJRU5ErkJggg=='),
  (character) => character.charCodeAt(0),
);

/**
 * Mirrors `apps/api`'s route, including its refusals — a mock that answered 200 to a size the
 * real route rejects would hide the bug rather than surface it.
 */
http.get('*/api/icon/:owner/:repo/:size.png', ({ params }) => {
  const fullName = `${String(params.owner)}/${String(params.repo)}`;
  const size = String(params.size);
  if (!['32', '64', '160'].includes(size)) return new HttpResponse(null, { status: 400 });

  const tool = MOCK_CORPUS.find((candidate) => candidate.full_name === fullName);
  if (!tool || tool.icon === null) return new HttpResponse(null, { status: 404 });

  return new HttpResponse(MOCK_ICON_PNG, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
  });
}),
```

**If MSW's path pattern will not match the `.png` suffix**, use `'*/api/icon/:owner/:repo/:file'` and derive `size` from `params.file` with `String(params.file).replace(/\.png$/, '')` — matching whatever fallback Task 8 landed on.

- [ ] **Step 4: Write the handler test**

Add to `apps/web/src/mocks/handlers.test.ts`, following the file's existing setup:

```ts
describe('GET /api/icon/:owner/:repo/:size.png', () => {
  it('serves PNG bytes for a tool that has an icon', async () => {
    const withIcon = MOCK_CORPUS.find((tool) => tool.icon !== null)!;
    const response = await fetch(`http://localhost/api/icon/${withIcon.full_name}/32.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('404s for a tool with no icon, like the real route', async () => {
    const without = MOCK_CORPUS.find((tool) => tool.icon === null)!;
    const response = await fetch(`http://localhost/api/icon/${without.full_name}/32.png`);
    expect(response.status).toBe(404);
  });

  it('rejects a size the real route does not derive', async () => {
    const withIcon = MOCK_CORPUS.find((tool) => tool.icon !== null)!;
    const response = await fetch(`http://localhost/api/icon/${withIcon.full_name}/128.png`);
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 5: Run the tests**

```bash
pnpm vitest run apps/web && mise run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/mocks
git commit -m "test(web): serve icons from the mock backend and give fixtures a spread of states"
```

---

## Task 11: The icon in a search result

**Files:**
- Modify: `apps/web/src/components/search/result-card.tsx`
- Modify: `apps/web/e2e/corpus.ts`, `apps/web/e2e/search.e2e.ts`

- [ ] **Step 1: Add the fixtures the tests select by rule**

In `apps/web/e2e/corpus.ts`, add after the `UNKNOWN_RUNTIME` block:

```ts
/**
 * A fixture with an icon, and one without — picked by rule rather than named, like
 * `BARE_TOOL`. Which documents these land on depends on the corpus, and a test that hardcoded
 * one would start asserting the fixture file the moment somebody added an icon to it.
 */
export const WITH_ICON: ToolDocument = (() => {
  const found = publicSearch({ hitsPerPage: 1000 }).hits.find((candidate) => candidate.icon !== null);
  if (!found) throw new Error('e2e/corpus.ts: no fixture with an icon');
  return found;
})();

export const ICONLESS: ToolDocument = (() => {
  const found = publicSearch({ hitsPerPage: 1000 }).hits.find((candidate) => candidate.icon === null);
  if (!found) throw new Error('e2e/corpus.ts: no fixture without an icon');
  return found;
})();
```

- [ ] **Step 2: Write the failing e2e tests**

Add to `apps/web/e2e/search.e2e.ts`, widening its `./corpus` import to include `ICONLESS` and `WITH_ICON`:

```ts
test.describe('result icons', () => {
  test('shows the project icon at the result size', async ({ page, visit }) => {
    await visit(`/search?q=${encodeURIComponent(WITH_ICON.name)}`);
    await settled(page);

    const card = page.locator(`main ul > li:has(a[href="/tools/${WITH_ICON.full_name}"])`);
    const icon = card.locator('[data-icon="image"]');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('src', `/api/icon/${WITH_ICON.full_name}/32.png`);
    // The 2× source is the 64px derivative, not an upscale of the 32.
    await expect(icon).toHaveAttribute('srcset', new RegExp(`/api/icon/${WITH_ICON.full_name}/64\\.png 2x`));
  });

  // A result list where some cards have an image and others have nothing would read as broken.
  test('stands a monogram in for a repo with no icon', async ({ page, visit }) => {
    await visit(`/search?q=${encodeURIComponent(ICONLESS.name)}`);
    await settled(page);

    const card = page.locator(`main ul > li:has(a[href="/tools/${ICONLESS.full_name}"])`);
    await expect(card.locator('[data-icon="monogram"]')).toBeVisible();
    await expect(card.locator('[data-icon="image"]')).toHaveCount(0);
  });

  // Decorative: the repository's name is right beside it, and announcing it twice is noise.
  test('keeps the icon out of the accessibility tree', async ({ page, visit }) => {
    await visit(`/search?q=${encodeURIComponent(WITH_ICON.name)}`);
    await settled(page);

    const card = page.locator(`main ul > li:has(a[href="/tools/${WITH_ICON.full_name}"])`);
    await expect(card.locator('[data-icon="image"]')).toHaveAttribute('aria-hidden', 'true');
    await expect(card.getByRole('img')).toHaveCount(0);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

```bash
mise run e2e apps/web/e2e/search.e2e.ts
```

Expected: FAIL — no element matches `[data-icon]`.

- [ ] **Step 4: Wire the icon into the card**

In `apps/web/src/components/search/result-card.tsx`, add the import:

```tsx
import { ToolIcon } from '../primitives/tool-icon';
```

and make it the first child of the `flex flex-wrap items-baseline` row, before the name:

```tsx
        <ToolIcon tool={tool} size={32} className="size-8 self-center text-2xl" />
```

`self-center` because the row is `items-baseline` for the text and an icon has no baseline to
share; `text-2xl` sets the em the monogram's `0.5em` font size resolves against.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
mise run e2e apps/web/e2e/search.e2e.ts
```

Expected: PASS, including the suite's existing tests. If any pre-existing test now fails on
layout — the roving tabindex, keyboard navigation — that is a real regression from the new
element; fix the card, not the test.

- [ ] **Step 6: Look at it**

```bash
mise run web:mock
```

Open `http://localhost:5173/search?q=k`, and check both themes with the header toggle. The
monogram tiles must be legible on light and dark, and the row must not jump when a card has an
image and its neighbour has a tile.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/search/result-card.tsx apps/web/e2e/corpus.ts apps/web/e2e/search.e2e.ts
git commit -m "feat(web): show a project icon on every search result"
```

---

## Task 12: The icon on the tool page

**Files:**
- Modify: `apps/web/src/routes/tool.tsx`
- Modify: `apps/web/e2e/tool.e2e.ts`

- [ ] **Step 1: Write the failing e2e tests**

Add to `apps/web/e2e/tool.e2e.ts`, widening its `./corpus` import to include `ICONLESS` and `WITH_ICON`:

```ts
test.describe('tool page icon', () => {
  test('shows the icon beside the heading, from the large derivative', async ({ page, visit }) => {
    await visit(`/tools/${WITH_ICON.full_name}`);

    const icon = page.locator('main [data-icon="image"]');
    await expect(icon).toBeVisible();
    // 160, not 64: the box renders at 64 and this keeps it sharp on a 2× display.
    await expect(icon).toHaveAttribute('src', `/api/icon/${WITH_ICON.full_name}/160.png`);
    await expect(toolHeading(page)).toBeVisible();
  });

  test('stands a monogram in for a repo with no icon', async ({ page, visit }) => {
    await visit(`/tools/${ICONLESS.full_name}`);
    await expect(page.locator('main [data-icon="monogram"]').first()).toBeVisible();
  });

  /**
   * The document and the cache are two systems, and eventual consistency is the contract
   * (§2.7): a document projected before its icon landed must degrade to the placeholder, not
   * to a broken-image glyph.
   */
  test('falls back to the monogram when the bytes are missing', async ({ page, visit }) => {
    await page.route(`**/api/icon/${WITH_ICON.full_name}/*`, (route) => route.fulfill({ status: 404 }));
    await visit(`/tools/${WITH_ICON.full_name}`);

    await expect(page.locator('main [data-icon="monogram"]').first()).toBeVisible();
    await expect(page.locator('main [data-icon="image"]')).toHaveCount(0);
  });

  /**
   * A client navigation swaps the document without remounting the page. Without the reset in
   * ToolIcon, one repo's failed icon would blank the next repo's.
   */
  test('recovers the icon after navigating away from a repo whose icon failed', async ({
    page,
    visit,
  }) => {
    await page.route(`**/api/icon/${ICONLESS.full_name}/*`, (route) => route.fulfill({ status: 404 }));
    await visit(`/tools/${ICONLESS.full_name}`);
    await expect(page.locator('main [data-icon="monogram"]').first()).toBeVisible();

    await visit(`/search?q=${encodeURIComponent(WITH_ICON.name)}`);
    await settled(page);
    await page.locator(`main ul > li a[href="/tools/${WITH_ICON.full_name}"]`).first().click();

    await expect(page.locator('main [data-icon="image"]').first()).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
mise run e2e apps/web/e2e/tool.e2e.ts
```

Expected: FAIL — no element matches `[data-icon]` on the tool page.

- [ ] **Step 3: Wire the icon into the page**

In `apps/web/src/routes/tool.tsx`, add the import:

```tsx
import { ToolIcon } from '../components/primitives/tool-icon';
```

and make it the first child of the heading row (the `flex flex-wrap items-baseline gap-2.5` div), before the `<h1>`:

```tsx
            <ToolIcon tool={tool} size={160} className="size-16 self-center text-5xl" />
```

The `<h1>` keeps the tool's name as its only text: the icon is `aria-hidden`, so the heading a
crawler and a screen reader read is unchanged, and §9's prerender contract still holds.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
mise run e2e apps/web/e2e/tool.e2e.ts
```

Expected: PASS, including the suite's existing heading assertions.

- [ ] **Step 5: Confirm the SEO surface still prerenders**

```bash
pnpm vitest run apps/web/prerender
```

Expected: PASS. The prerender walks the same route tree, so the `<img>` is emitted into the
static HTML with no change to `prerender/html.ts`'s assertions — but this is the check that
proves it rather than assuming it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/tool.tsx apps/web/e2e/tool.e2e.ts
git commit -m "feat(web): show the project icon on the tool page"
```

---

## Task 13: Documentation and the full gate

**Files:**
- Modify: `AGENTS.md`, `ROADMAP.md`

- [ ] **Step 1: Update the cache layout in AGENTS.md §3**

In the `cache/` tree under §3, add to the `repos/{owner}/{repo}/` block, after the `releases.json` line:

```
│   ├── icon.src            # icon bytes, verbatim; content type is in icon.json
│   ├── icon-{32,64,160}.png # derived with sharp — re-derivable offline, never re-crawled
│   ├── icon.json           # { source, source_url, content_type, bytes, etag, sizes, fetched_at, error }
```

- [ ] **Step 2: Update the document shape in AGENTS.md §5**

In the `Document shape` block, after the `readme_excerpt` line:

```ts
  icon,                        // { source, source_url, fetched_at } | null — bytes via apps/api
```

- [ ] **Step 3: Note the surface in §9**

In §9's tool-page paragraph, after the sentence about the README coming from the cache, add:

```
The icon comes the same way and for the same reason — `GET /api/icon/{owner}/{repo}/{32|64|160}.png`
serves a PNG the crawler rasterised from the verbatim source, so nothing active from a
stranger's SVG ever reaches a reader. The document's `icon` descriptor says whether one
exists, so a repo without one renders a monogram and fires no request.
```

- [ ] **Step 4: Update ROADMAP.md**

Under **v1 → Write side → crawler**, append to that bullet:

```
Icons ship ahead of it: `apps/workers/src/crawler/icon.ts` is written and tested, the call
site is in the crawler's TODO, and `mise run icon -- --repo owner/name` runs it standalone.
```

- [ ] **Step 5: Run the full gate**

```bash
mise run ci
```

Expected: PASS — check, lint, test, taxonomy:check.

```bash
mise run e2e
```

Expected: PASS, every suite.

- [ ] **Step 6: Verify the dependency boundary by hand**

```bash
grep -rn "sharp" apps/api/src apps/web/src packages/ --include=*.ts --include=*.tsx
```

Expected: no matches. `sharp` is a `apps/workers` dependency only (§7); a hit in `apps/web/src`
would be a build-time bug and a `node:*` import in a bundle that ships to strangers.

```bash
mise run build && grep -rl "KECO_MOCK_CORPUS_DO_NOT_SHIP" apps/web/dist || echo "clean"
```

Expected: the build passes its own `dist/` scan and prints `clean`.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md ROADMAP.md
git commit -m "docs: record the icon cache keys, document field and API route"
```

---

## Not in this plan

Named so nobody adds them mid-flight:

- **Finishing the crawler or the projector.** Both are stubs by design here; the icon call sites go into their TODO blocks and nothing more.
- **A full rebuild or alias swap.** `icon` is not a `filterableAttribute`, so re-projecting is the whole migration.
- **Homepage favicons, CNCF landscape logos, icon overrides, or making icon presence filterable.** All four are §8 of the spec, with reasons.
