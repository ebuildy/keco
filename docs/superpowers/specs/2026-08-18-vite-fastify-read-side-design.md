# Read side on Vite + Fastify — design

Date: 2026-08-18
Status: designed, not implemented

## Problem

AGENTS.md §0 opens by admitting the repository does not match itself: the write side
(`packages/*`, `apps/workers`) is built as documented, while the read side is still a Next.js 16
App Router application under `apps/web`, and `apps/api` does not exist. §7 and §9–§12 describe
the target — three deployables behind one Fastify process — and forbid adding new Next.js
surface in the meantime. The read side is therefore frozen: it cannot grow, and it contradicts
the contract every other part of the repository is written against.

This design closes that gap for two of the three deployables. It replaces Next.js with a Vite +
React static SPA and introduces `apps/api` as a Fastify process that serves both the JSON routes
and the built SPA.

It is a rewrite, not a migration of data. The read model is disposable (§2.3): the new frontend
re-queries the same `tools` index the old one did, and nothing on the write side is touched.

## Scope

**In:**

- `apps/web` rebuilt as a Vite + React SPA with `react-router` in declarative mode, porting the
  three portal routes at their current fidelity.
- `apps/web/prerender` — the build-time prerender §9 requires, plus `sitemap.xml` and
  `robots.txt`.
- `apps/api` — a new Fastify deployable holding the ported REST routes, the README rendering
  endpoint, admin session login, the commands endpoint, the MCP and chat placeholders, and
  static serving of the SPA with a prerendered-file-first fallback.
- The `packages/core` changes that make the taxonomy and the filter algebra usable from a
  browser bundle without violating §7.
- Reconciliation of `.env.example`, `eslint.config.mjs`, `mise.toml`, `pnpm-workspace.yaml`,
  AGENTS.md/CLAUDE.md and ROADMAP.md with what is actually built.

**Out, deliberately:**

- **`apps/backoffice`.** The third deployable of §7 is not created. Its API surface
  (`/api/admin/*`, `/api/commands/*`) ships here because that is the contract, not the UI; the
  SPA itself is a separate session with its own design. `/admin` is reserved as a `noindex` 404
  until then.
- **UI build-out.** No facet sidebar, no install tabs, no keyboard navigation, no styling
  system. The pages port at the fidelity they have today. Those are ROADMAP v1 "Read side"
  items and each deserves its own pass.
- **Filling in the 501s.** MCP and chat stay unimplemented; only their host changes.
- **`packages/readme`.** The markdown pipeline stays inside `apps/api`. See the README decision
  below.
- **Anything on the write side.** §2–§6 are unaffected.

## Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Deployables this session | web + api; backoffice deferred, `/admin` reserved | scaffolding all three; keeping admin inside `apps/web` |
| Depth | structural port + what §9 makes non-optional | pure 1:1 port with no SEO surface; full §9 UI build-out |
| Taxonomy in the browser | `browser` field remapping the byte-loading module in `@keco/core` | checked-in codegen with a CI drift check; `GET /api/taxonomy` at runtime |
| Filter algebra | moved into `@keco/core`, re-exported by `@keco/query` | letting `apps/web` import `@keco/query` (needs an ADR); duplicating it in the portal |
| Prerender rendering | `renderToString` over the same React route tree | injecting a template into the built `index.html`; headless-browser snapshotting |
| README pipeline | stays in `apps/api`; prerender inlines `readme_excerpt` instead | a shared `packages/readme`; prerender fetching from a live API during the build |
| Static fallback lookup | boot-loaded manifest of prerendered paths | `fs.stat` per request |

## Architecture

Three logical surfaces, **one Node process** in production:

```
apps/web/            Vite + React SPA ────build───▶ apps/web/dist/
apps/web/prerender/  Node build step  ────────────▶ apps/web/dist/prerendered/**.html
                                                    sitemap.xml, robots.txt, manifest.json
                                                                │
apps/api/            Fastify: /api/* + @fastify/static ◀────────┘
```

Data flow, per §2 and §9:

| Path | Route |
|---|---|
| Portal search | browser → Meilisearch directly (search-only key, ~80 ms debounce, no API hop) |
| Portal tool page | browser → Meilisearch `getDocument`, plus `GET /api/readme/{owner}/{repo}` |
| Prerender | build time → Meilisearch only. No cache access, no other network |
| REST / MCP / chat | Fastify → `@keco/query` → Meilisearch |
| Commands | Fastify → journal append or checkpoint reset. Never inline work |

Nothing on the read side writes a read model. The one write path is `/api/commands/*`, and it
writes to the *write* model — an appended event or a reset checkpoint (§11).

## `packages/core` — the two changes that make §7 hold

§7 says browser bundles may import `@keco/core` and `meilisearch` only, and that any `node:*`
import from a frontend is a build-time bug. Two things in the current tree contradict that.

### Isomorphic taxonomy loading

`packages/core/src/taxonomy.ts` calls `readFileSync` at module load, and everything in
`@keco/core` transitively depends on it. The split:

- `src/taxonomy-source.ts` — Node. Owns `taxonomyPath()`, `existsSync`, `readFileSync`, and
  keeps exporting `readTaxonomyFile(path)` so the existing not-found test stays reachable.
- `src/taxonomy-source.browser.ts` — browser. `import raw from '../taxonomy.yaml?raw'` and
  return it. `?raw` is a Vite primitive; no YAML plugin is involved.
- `src/taxonomy.ts` — unchanged in substance. It imports the source module and keeps *all* the
  parsing and zod validation, so both environments validate identically and a malformed
  taxonomy still takes the bundle down at load (§6).
- `package.json` gains
  `"browser": { "./src/taxonomy-source.ts": "./src/taxonomy-source.browser.ts" }`.

Vite honours the `browser` field; Node, `tsx` and vitest do not see it, so workers and the
prerender keep the filesystem path. A `src/globals.d.ts` declares `*.yaml?raw` so the browser
variant typechecks under the workspace `tsc`.

The comment block in `taxonomy.ts` that says the bundler path is "unverified" is replaced with
what is now true.

### The filter algebra moves down

Browser-direct search needs `buildFilters`, `selectionFromParams`, `defaultFacets` and
`familyAttribute`. They are pure functions over the taxonomy with no I/O, but they currently
live in `packages/query/src/filters.ts` and `packages/search/src/settings.ts`, both off-limits
to a browser bundle.

- `packages/query/src/filters.ts` and `filters.test.ts` move to `packages/core/src/read.ts` and
  `read.test.ts`.
- `familyAttribute` and the `tools` index name move from `@keco/search` to the same module.
  `packages/search/src/settings.ts` imports `familyAttribute` from core to build its filterable
  attribute list, and re-exports `TOOLS_ALIAS` so no existing caller changes.
- `@keco/query` re-exports the same names from core, so `apps/api` and any other consumer keep
  their current imports.

There is no import cycle: `@keco/core` imports neither `@keco/search` nor `@keco/query`.

Consequence for §11: the portal and the API share **one filter algebra**, not one query client.
The portal builds its own `Meilisearch` instance with the search-only key — that is the whole
point of §9's browser-direct search — while REST, MCP and chat go through `@keco/query`. §11's
"one implementation" claim is preserved at the level that can drift (the taxonomy → filter
mapping) and is documented as such.

### `createQueryClient`

Drops its `NEXT_PUBLIC_*` fallbacks. It is now server-side only, reading `MEILI_HOST` and
`MEILI_MASTER_KEY`, and its comment about Next's inlining behaviour is replaced with the Vite
rule from §12.

## `apps/web`

```
apps/web/
├── index.html
├── vite.config.ts
├── package.json            @keco/core + meilisearch + react + react-router (bundle deps)
├── src/
│   ├── main.tsx            client entry
│   ├── app.tsx             the route tree — imported by main.tsx AND by the prerender
│   ├── routes/
│   │   ├── home.tsx        hero search, chip rows, highest momentum
│   │   ├── search.tsx      URL-synced search
│   │   ├── tool.tsx        /tools/:owner/:repo
│   │   └── not-found.tsx
│   └── lib/
│       ├── meili.ts        browser client, VITE_MEILI_HOST + VITE_MEILI_SEARCH_KEY
│       ├── topics.ts       moved from the Next app; now imports @keco/core only
│       ├── topics.test.ts  moved unchanged
│       └── bootstrap.ts    typed read of window.__KECO_DATA__
└── prerender/
    └── index.ts            Node build step
```

Routes port one-to-one from the Next pages. `/` and `/search` keep their current markup and
copy; `/tools/:owner/:repo` keeps its sidebar, install block, score block and related list, and
gains a client-side fetch of `/api/readme/*` in place of the raw `<pre>` dump.

URL-synced state is unchanged in behaviour: `selectionFromParams` already accepts a
`URLSearchParams`, which is exactly what `useSearchParams()` hands it.

### Client entry and hydration

```
#root has server-rendered markup  →  hydrateRoot(root, <App/>)
#root is empty                    →  createRoot(root).render(<App/>)
```

Prerendered pages embed their data as `window.__KECO_DATA__` so the first client render
produces the same tree the prerender produced. Non-prerendered routes are served the plain
`index.html` shell and mount normally.

### The prerender

Runs after `vite build`, as `pnpm -F @keco/web prerender`.

1. Query `tools` sorted by `score_total` desc, `hitsPerPage` 1000 (§9's "top N ≈ 1000"; §5's
   `pagination.maxTotalHits` must accommodate it).
2. For each hit, `renderToString` the route tree from `src/app.tsx` under a static router at
   `/tools/{full_name}`, with the tool document supplied through the same bootstrap channel the
   client reads.
3. Write `dist/prerendered/tools/{owner}/{repo}.html` containing `<title>`, meta description,
   `<h1>`, the tool summary, `readme_excerpt`, a JSON-LD `SoftwareApplication` block, the
   rendered markup, and the `window.__KECO_DATA__` script.
4. Write `sitemap.xml` (home + every emitted page, `lastModified` = `indexed_at`),
   `robots.txt` (disallow `/admin`), and `manifest.json` — the list of emitted paths, which
   `apps/api` loads at boot.

Because the prerender only reads the read model, it needs neither `@keco/cache` nor a running
API. It reads at build time only, and no request path acquires a renderer (§9).

**On the README.** §9 as written requires the rendered README inlined into the prerendered
page. This design does not do that: the markdown pipeline stays in `apps/api`, and the
prerender inlines `readme_excerpt` from the `tools` document instead — roughly 1.5 KB of real
prose per page, already in the read model. The full sanitised README arrives client-side. This
is a deliberate reduction of §9's SEO surface, taken to keep the prerender a pure read-model
consumer with no second copy of the markdown pipeline, and §9 is amended to say so rather than
left describing something the code does not do.

**Failure modes.** Meilisearch unreachable fails the build — a portal shipped without its SEO
surface is a blocking regression (§9). An index that is merely empty emits zero tool pages and
a home-only sitemap and exits 0; that is the true state of the system before the first crawl,
not an error.

## `apps/api`

```
apps/api/src/
├── index.ts                 listen
├── server.ts                build() → a configured Fastify instance
├── env.ts                   zod-validated config, read once, fails loudly at boot
├── query.ts                 createQueryClient — the only Meilisearch handle
├── cache.ts                 createCacheFromEnv — read by key only, never write, never list
├── plugins/
│   ├── static.ts            @fastify/static + the prerendered-first not-found handler
│   └── session.ts           signed cookie helpers, HttpOnly, SameSite=Strict
└── routes/
    ├── v1/search.ts         ported from the Next route
    ├── v1/tool.ts           ported from the Next route
    ├── readme/index.ts      cached markdown → sanitised HTML
    ├── mcp/index.ts         the five tool descriptions, still 501
    ├── chat/index.ts        501 (v2)
    ├── admin/index.ts       POST /login, POST /logout, GET /session
    └── commands/index.ts    ported; admin session OR Bearer COMMAND_TOKEN
```

`server.ts` exports `build()` returning the instance rather than listening, so every test uses
`fastify.inject` and no test opens a socket.

### Registration order

§14 is explicit that static assets and JSON routes sharing one instance is a trap. The order is:

1. `/api/*` routes.
2. `@fastify/static`, rooted at `apps/web/dist`, `wildcard: false` so it cannot shadow `/api/*`.
3. `setNotFoundHandler`, last:
   - path starts with `/api/` → JSON 404.
   - path is `/admin` or below → 404, `X-Robots-Tag: noindex`. Reserved for the backoffice.
   - the boot-loaded manifest contains the path → send that prerendered file.
   - otherwise → `index.html`.

The manifest lookup is a set membership test on a value produced by our own build. It is
faster than an `fs.stat` per request and it cannot be walked out of the dist directory by a
crafted URL.

### `/api/readme/{owner}/{repo}`

The one place the read side touches write-side storage: a read of an immutable blob, by key
(§9). It reads `readme.md` and `readme.json` through the `Storage` port, then renders with
rehype-sanitize, rewrites relative image and link URLs against `image_base_url`, strips the
leading badge-only paragraph, and applies Shiki highlighting. Returns 404 when the repo has no
cached README. Sanitisation is not conditional: rendering untrusted README markdown without it
is a stored-XSS hole across the whole corpus.

### Admin auth

§12 replaces the Auth.js + GitHub OAuth design the Next layout assumed. `POST /api/admin/login`
compares the submitted password against `ADMIN_PASSWORD_HASH` with a constant-time comparison
and sets a signed, `HttpOnly`, `SameSite=Strict` session cookie. There is one admin, and the
backoffice can only read and enqueue.

Every handler authorizes itself. No route relies on a hook having run — a route that trusts an
upstream guard is one refactor away from being unguarded (§12).

## Configuration and tooling

**`.env.example`** — `NEXT_PUBLIC_MEILI_HOST` / `NEXT_PUBLIC_MEILI_SEARCH_KEY` become
`VITE_MEILI_HOST` / `VITE_MEILI_SEARCH_KEY`; `AUTH_SECRET`, `AUTH_GITHUB_ID`,
`AUTH_GITHUB_SECRET` and `ADMIN_LOGINS` are replaced by `ADMIN_PASSWORD_HASH` and
`SESSION_SECRET`; `PORT` and `SITE_URL` are added. Every variable keeps its comment naming the
surface that reads it. The `VITE_` prefix carries the same warning §12 gives it: anything with
that prefix is inlined into the shipped bundle, permanently.

**`eslint.config.mjs`** — the §7 boundaries, restated for the new layout:

| Scope | Rule |
|---|---|
| `apps/web/src/**` | browser bundle: no `@keco/cache`, `@keco/github`, `@keco/signals`, `@keco/analyze`, `@keco/query`, `@keco/search`, and no `node:*` |
| `apps/web/prerender/**` | Node build tooling: may import `@keco/query`; still no write-side packages |
| `apps/api/**` | may import `@keco/query`, `@keco/core`, `@keco/cache`, `@keco/search`; never `@keco/github`, `@keco/signals`, `@keco/analyze` |

The `apps/web` rule today forbids only the three write-side packages; the browser rule is
strictly stronger and the `apps/api` rule does not exist yet. The `**/.next/**` ignore is
dropped.

**`mise.toml`** — `web`, `api` and `prerender` become individual tasks, and `dev` is
`depends = ["web", "api"]` so mise runs the two in parallel rather than chaining them. `build`
is `vite build` → prerender → API typecheck, in that order. All Next.js wording is removed,
including the `NODE_ENV` comment in `[env]` that exists only because of `next build`.

In development the Vite dev server proxies `/api` to the Fastify port, so the portal reaches
`/api/readme/*` at the same path it uses in production and no CORS or base-URL branch is needed
in client code.

**`pnpm-workspace.yaml`** — drop the `sharp` allowBuild, which is Next's image optimizer.

**Docs** — AGENTS.md/CLAUDE.md §0 rewritten (the read side now matches, with the backoffice
named as the remaining exception), §7 noting `apps/web/prerender` as Node build tooling, §9's
SEO paragraph amended for `readme_excerpt`, §11 clarified on the shared filter algebra.
ROADMAP.md updated so the "Read side" and "Auth" items reflect what shipped.

## Error handling

| Surface | Failure | Behaviour |
|---|---|---|
| `apps/api` boot | missing or malformed env | zod throws, non-zero exit, message names the variable |
| `apps/api` boot | `manifest.json` absent | start with an empty manifest; every route falls back to `index.html` |
| `/api/v1/*` | Meilisearch down | 503 JSON, no stack trace to the client |
| `/api/readme/*` | README not cached | 404 JSON. Never renders unsanitised content |
| `/api/commands/*` | bad or missing token | 401, constant-time compare, no CORS |
| portal | Meilisearch unreachable | route error boundary with a real message, not a blank SPA |
| portal | unknown `owner/repo` | the not-found route, not an exception |
| prerender | Meilisearch unreachable | build fails |
| prerender | index empty | 0 tool pages, home-only sitemap, exit 0 |

## Testing

Everything stays `environment: 'node'`; no jsdom is introduced. `renderToString` runs in Node,
and the pure logic under test has no DOM.

- **Moved, must keep passing:** `read.test.ts` (was `packages/query/src/filters.test.ts`),
  `apps/web/src/lib/topics.test.ts`.
- **`packages/core`:** the browser taxonomy source parses and validates the same file to the
  same object as the Node one.
- **`apps/api`,** all via `fastify.inject`: `/api/v1/search` and `/api/v1/tools/*` response
  shapes, including that no internal id leaks; `/api/readme/*` returning 404 when uncached and
  stripping script/event-handler attributes from a hostile fixture; the commands auth matrix
  (no token, wrong token, right token, unknown command); the not-found handler choosing a
  prerendered file when the manifest lists it and `index.html` when it does not; `/api/*`
  returning JSON 404 rather than the SPA shell.
- **`apps/web/prerender`:** HTML assembly over a fixture `ToolDocument` — asserts `<h1>`,
  `<title>`, the meta description and the JSON-LD block are present and that
  `readme_excerpt` reaches the output.
- `vitest.config.ts` include patterns extended to cover `apps/*/prerender/**/*.test.ts`.

## Definition of done

Beyond §15's `mise run ci`:

1. `mise run build` produces `apps/web/dist` with a prerendered tool page carrying a real
   `<h1>`, `<title>`, meta description and JSON-LD, plus `sitemap.xml`, `robots.txt` and
   `manifest.json`.
2. `mise run dev` serves the portal with working search-as-you-type against a local
   Meilisearch, and a hard refresh on `/tools/{owner}/{repo}` resolves rather than 404ing.
3. No `VITE_`-prefixed secret exists, and `apps/web/dist` contains neither the master key nor
   any `node:` import. Grep the built bundle as evidence, not the source.
4. Nothing under `apps/web/src` imports a write-side package or `node:*`; lint proves it.
5. No Next.js dependency remains in any `package.json`, and no `.next` directory is produced.
6. AGENTS.md §0, §7, §9, §11 and ROADMAP.md describe what is in the tree.
