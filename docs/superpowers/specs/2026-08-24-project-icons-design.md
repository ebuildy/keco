# Project icons — design

**Date:** 2026-08-24
**Status:** approved, not implemented
**Touches:** `packages/core`, `packages/cache`, `apps/workers`, `apps/api`, `apps/web`

Every tool in the corpus gets an icon: a small one beside its name in a search result, a
larger one beside the `<h1>` on its page. The write side finds and downloads the artwork; the
read side serves it from the cache by key.

## 0. Context: the crawler does not exist yet

`apps/workers/src/crawler/index.ts` is a stub. It parses its arguments, logs a warning and
exits; ROADMAP.md lists the crawler as not started. So the icon work cannot be a change *to*
the crawler. It is a self-contained module the crawler calls, with its call site written into
the crawler's existing TODO block as real code, plus two independent proofs that it works
today (§3).

Nothing else here is blocked: the cache, the API route, the document field and the entire
portal surface are implementable and testable now.

## 1. Data contract

`ToolDocument` (`packages/core/src/schemas.ts`) gains one nullable field:

```ts
icon: z.object({
  source: z.enum(['repo-logo', 'owner-avatar']),
  /** Provenance — where the artwork actually came from. */
  source_url: z.url(),
  fetched_at: z.iso.datetime(),
}).nullable(),
```

`source` distinguishes a genuine project mark from an org avatar, which the backoffice needs
in order to explain what a reader is looking at, and which a future ranking or UI tweak can
read without re-deriving it.

This is **not** a `filterableAttribute`, so it is a plain document change: applied by
re-projecting from the cache with zero network calls (AGENTS.md §15.3). No settings change, no
forced alias swap.

The analyzer is untouched. An icon is crawler output, not a classification, so the projector
reads it from `repos/**` beside `repo.json`.

## 2. Write side

### 2.1 Cache keys

New entries in `repoKeys` (`packages/cache/src/keys.ts`):

```
repos/{owner}/{repo}/icon.src              # the fetched bytes, verbatim
repos/{owner}/{repo}/icon-32.png           # derived
repos/{owner}/{repo}/icon-64.png           # derived
repos/{owner}/{repo}/icon-160.png          # derived
repos/{owner}/{repo}/icon.json             # metadata
```

`icon.json`:

```ts
{
  source: 'repo-logo' | 'owner-avatar' | null,   // null ⇒ the attempt failed
  source_url: string | null,
  content_type: string | null,                   // of icon.src
  bytes: number | null,
  etag: string | null,
  sizes: number[],                               // [32, 64, 160] when derivation succeeded
  fetched_at: string,
  error: string | null,
}
```

`icon.src` carries **no file extension**. Discovering one would mean listing a prefix to see
what is there, and §14 forbids listing the cache. The real content type is recorded in
`icon.json` and read from there.

### 2.2 Verbatim original, derived PNGs

AGENTS.md §3 requires that everything fetched is stored verbatim, so that a parser bug is
fixed by re-deriving rather than re-crawling. Re-encoding on the way in would break that.

Both properties are kept by storing both: `icon.src` is the untouched response body, and the
three PNGs are derived artifacts beside it — the same relationship `analysis/**` has to
`repos/**`. A bug in the resize step is fixed by re-deriving from the cached originals, with
no GitHub calls.

### 2.3 The module

`apps/workers/src/crawler/icon.ts`, taking `repo.json`, `tree.json`, the raw `readme.md`
(tier 2 below needs it), a `Storage` and a fetcher. All three inputs are already in the cache
by the time the crawler calls it, so the module reads them through the `Storage` port and
never touches the filesystem directly and never reads a read model.

**Candidate resolution**, in order:

1. From `tree.json`, which the crawler already fetches, so this costs no extra request:
   `.github/logo.*`, `logo.*`, `docs/logo.*`, `docs/images/logo.*`, `assets/logo.*`,
   `static/logo.*`, `images/logo.*`. Accepted extensions: `svg`, `png`, `jpg`, `jpeg`, `webp`.
2. Otherwise the first image in `readme.md`, subject to three filters:
   - **Host allowlist.** A relative path (resolved against `image_base_url` from
     `readme.json`, exactly as the README renderer does) or an absolute URL on
     `raw.githubusercontent.com` / `user-images.githubusercontent.com` /
     `github.com/…/assets/…`. Any other host is skipped rather than fetched. README markdown
     is untrusted input written by 30k strangers, and a candidate URL is a URL this system
     would otherwise fetch on their instruction — the same reason homepage favicons are out
     of scope in §8.
   - **Badge hosts**, skipped: `shields.io`, `img.shields.io`, `badge.fury.io`, `codecov.io`,
     `goreportcard.com`, `travis-ci.*`, `circleci.com`,
     `github.com/*/actions/workflows/*/badge.svg`.
   - **Badge rows**, skipped: any paragraph containing three or more images. That shape is a
     badge row, not a logo.

   The resolved URL must end in one of the same extensions as tier 1.
3. Otherwise `owner.avatar_url` from `repo.json`, requested at `?s=460` so the 160px
   derivative is never an upscale.

**Fetching:**

- Conditional on the `etag` stored in `icon.json`; a 304 short-circuits the whole module.
- Hard cap of 512 KB; a larger body is abandoned, not truncated.
- A non-image `content-type` is rejected.
- Repo logos come from `raw.githubusercontent.com`, a CDN rather than the API, so they do not
  spend the 5000 points/hour budget that §14 warns the analyzer and crawler already share.

**Deriving** with `sharp`: three PNGs at 32, 64 and 160, transparency preserved, aspect ratio
preserved, fitted *inside* the box rather than padded to a square — a wide wordmark stays a
wide wordmark, and the portal handles the square with `object-contain`. Rasterising also
strips every active element out of an SVG, so no separate sanitiser is needed.

`sharp` is a new dependency of `apps/workers` only. It must never be reachable from
`apps/api`, `apps/web` or `apps/backoffice`.

**Failure degrades, never fails** (§4.2). No icon, `icon.json` records the failed attempt with
its `error` so the next sweep does not retry a known-dead URL, and `RepoFetched` is emitted
regardless. A repo without an icon is a repo without an icon; it is never a failed crawl.

### 2.4 `content_hash` is not redefined

`content_hash` stays `hash(repo.json core fields + readme + tree)`. A logo that is added,
moved or removed changes `tree.json` and therefore the hash already. A logo replaced in place
at the same path is caught by the ETag on the next crawl instead. Folding icon bytes into the
hash would invalidate the entire corpus — every analysis and every projection — for a
cosmetic field.

### 2.5 Projector

Reads `icon.json` beside `repo.json` and writes the `icon` descriptor onto the document, or
`null` when the file is missing or records a failure. No network, as always.

## 3. Proving it works before the crawler lands

Two independent proofs, because the call site cannot yet be exercised by running the crawler:

1. **Fixture tests** (`apps/workers/src/crawler/icon.test.ts`) over committed `tree.json` and
   README fixtures: each candidate tier, badge filtering, the three-images-in-a-paragraph
   rule, the 512 KB cap, a non-image content type, a 304, and the failure path writing
   `icon.json` with an `error`. This is the §13 rule — a new rule requires a fixture proving
   it — applied to resolution rules.
2. **A dev task**, `mise run icon -- --repo owner/name`, which fetches the two GitHub
   documents the module needs and runs the real pipeline against the real cache. The feature
   is demonstrable end to end today, not only once the crawler exists.

## 4. `apps/api`

`GET /api/icon/:owner/:repo/:size.png`, modelled on `routes/readme.ts`:

- Same `owner` / `repo` regexes. The cache key is built from path parameters, so this is a
  traversal surface and the vocabulary is pinned to what GitHub actually allows.
- `size` is a zod enum of `32 | 64 | 160`. Nothing else reaches a cache key.
- 404 when the key is absent — an uncrawled repo is a miss, not an error.
- Headers: `Content-Type: image/png`, `Cache-Control: public, max-age=86400`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`.
- Rate limit 300/min per IP. These are static bytes read by key; the README route's 30/min
  exists because it runs a 1.4s markdown pipeline, and that reasoning does not transfer.

A read of an immutable blob by key. Never a write, never a list.

## 5. Portal (`apps/web`)

### 5.1 The primitive

`components/primitives/tool-icon.tsx`, props `{ tool, size }`.

- `tool.icon !== null` ⇒ an `<img>` against `/api/icon/{owner}/{repo}/{size}.png`.
- Otherwise a **monogram tile**: the first letter of the repo name on a hue derived
  deterministically from `full_name`. The hue is decorative and encodes nothing, so it stays
  clear of §9's rule that colour encodes state rather than category.
- `onError` falls back to the monogram, so a cache miss renders a placeholder rather than a
  broken-image glyph.

Knowing from the document whether an icon exists is what avoids a request-then-404 flash on
every iconless card.

### 5.2 Placement

- **Result card** (`components/search/result-card.tsx`): a 32px box left of the name,
  `src=…/32.png` with `srcSet` adding `64.png` at 2×, `alt=""` — decorative, because the name
  is immediately adjacent and a screen reader announcing it twice is noise.
- **Tool page** (`routes/tool.tsx`): a 64px box beside the `<h1>`, served from `160.png` so it
  stays sharp on a 2× display.

Prerendered HTML carries the `<img>` unchanged. The prerender gains no new assertion: the tag
is static markup emitted by the same React tree the browser mounts.

### 5.3 Mock backend

Curated fixtures get a spread of states — some `repo-logo`, some `owner-avatar`, at least one
`null` — so the monogram path is reachable without breaking anything. A new msw handler serves
a deterministic generated PNG for `*/api/icon/:owner/:repo/:size.png`.

The fabricated-data rule of §14 is about fabricated *claims*, above all install commands. A
placeholder square in a mock corpus that already carries `KECO_MOCK_CORPUS_DO_NOT_SHIP` in
every document's `discovery_source` is not one, and all five layers keeping the mock out of a
production build apply to it unchanged.

### 5.4 End-to-end coverage

Required by §13, not a follow-up:

- `search.e2e.ts`: a card whose tool has an icon renders an `<img>` at the 32px source; a card
  whose tool has none renders the monogram.
- `tool.e2e.ts`: the tool page renders the large icon from the 160px source; an iconless tool
  renders the monogram; a broken source falls back to the monogram.

## 6. Test plan

| Layer | Test |
|---|---|
| `packages/core` | schema test covering both `icon` shapes and `null` |
| `packages/cache` | key test for `icon.src`, `icon-{n}.png`, `icon.json` |
| `apps/workers` | `icon.test.ts` — resolution tiers, host allowlist, badge filtering, badge rows, cap, non-image type, 304, failure path |
| `apps/workers` | projector test: `icon.json` present / missing / failed ⇒ descriptor / `null` / `null` |
| `apps/api` | route tests — 200, 404, rejected size, traversal attempt, response headers |
| `apps/web` | unit test for monogram hue determinism |
| `apps/web` | the four e2e tests in §5.4 |

## 7. Definition of done

1. `mise run ci` green.
2. `mise run e2e` green, including the four new tests.
3. The document change applied by re-projecting from cache, with no network calls.
4. `sharp` present in `apps/workers` only, and reachable from neither `apps/api` nor a browser
   bundle — asserted by the §7 lint boundaries.
5. The tool page still prerenders with a real `<h1>`, metadata and JSON-LD.
6. Nothing on the read side writes a read model; nothing on the write side reads one.
7. AGENTS.md §3 (cache layout) and §5 (document shape) updated to name the new keys and field.

## 8. Explicitly out of scope

- Homepage favicon scraping. It means crawling arbitrary third-party sites, which is a new
  SSRF surface, a new TTL cache namespace and a new class of failure, for a marginal coverage
  gain over the avatar fallback.
- CNCF landscape logos as a source. The landscape crawler does not exist yet; when it does,
  it slots in as a candidate tier above `owner-avatar` without changing anything else here.
- Any icon override or upload UI. That is curation, rejected in §1 and §10.
- Making icon presence filterable or sortable. It carries no signal worth querying, and it
  would turn a document change into a settings change and an alias swap.
