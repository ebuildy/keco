# @keco/web — the public portal

The read-only search portal for the Kubernetes ecosystem: a **static SPA** built with Vite and
React, served by [`@keco/api`](../api) from a `dist/` folder.

It is the largest surface in Keco and the one with the least machinery behind it. There is no
server, no SSR framework, no data layer of its own — it queries the read model directly and
renders it.

> [!NOTE]
> This app is a *consumer* of the read model. It never writes anything, anywhere. The rules it
> lives by are [AGENTS.md](../../AGENTS.md) §2 (CQRS), §7 (import boundaries) and §9 (the
> portal itself).

## Architecture

Two data paths, and the split is the whole design:

```
                         ┌──────────────────────┐
  search, facets,        │                      │   VITE_MEILI_SEARCH_KEY
  momentum, tool doc ───▶│     Meilisearch      │   (search-only, scoped to `tools`)
                         │      `tools`         │
  browser                └──────────────────────┘
     │
     │  GET /api/readme/{owner}/{repo}
     └────────────────────▶ apps/api ──▶ cache (raw markdown) ──▶ sanitised HTML
```

**Search is browser → Meilisearch, directly.** No backend round-trip per keystroke — that is
the entire reason the search key is public. `src/lib/meili.ts` builds the client lazily;
`src/lib/search.ts` is ~60 lines of `.search()` calls over the filter/sort *algebra* that lives
in `@keco/core` and is shared with the API's `@keco/query`. The algebra is the part that can
silently drift between the two sides; a `.search()` call cannot.

**The README never comes from the index.** It lives in the write-side cache, which a browser
cannot read, so it arrives from `apps/api` already sanitised server-side. Rendering untrusted
README markdown in the browser would be a stored-XSS hole across the whole corpus.

### Layout

| Path | What it is |
|---|---|
| `src/app.tsx` | The route tree — the one module both `main.tsx` and the prerender import |
| `src/main.tsx` | Browser entry; hydrates prerendered markup, mounts fresh otherwise |
| `src/routes/` | `home` · `search` · `tool` · `not-found` |
| `src/lib/search.ts` | Every Meilisearch call the portal makes, one per function |
| `src/lib/meili.ts` | The search-only client |
| `src/lib/bootstrap.ts` | How a prerendered page hands its document to the React tree |
| `src/lib/topics.ts` | Facet distribution → home-page chip rows (pure, unit-tested) |
| `prerender/` | **Node build tooling, not bundle code** — read model → static HTML |

### Routes

| Route | Data source | Prerendered |
|---|---|---|
| `/` | facet distribution + `whatsHot()`, both from Meilisearch | no |
| `/search` | Meilisearch; all state in the URL (`?q=&kind=&domain=&install=&sort=&view=`) | no |
| `/tools/:owner/:repo` | `tools` document, then `/api/readme/...` for the body | **yes** — top 1000 by score |

### SEO without SSR

Dropping SSR would make a search portal unindexable, so `prerender/` is not optional. At build
time it queries `tools` for the top 1000 by `score_total` and renders **the same route tree the
browser mounts** (`renderToString` under a `StaticRouter`) into one real HTML file per tool
page, with `<h1>`, `<title>`, meta description, JSON-LD and the document's `readme_excerpt` as
indexable prose. It also emits `sitemap.xml`, `robots.txt` and the manifest `apps/api` reads at
boot to decide which paths have a static file.

> [!IMPORTANT]
> A change that makes the top tool pages non-prerenderable is a **blocking regression**, not a
> follow-up. The prerender reads the read model at build time only — no request path may ever
> acquire a server renderer.

## Development

```bash
mise run dev          # this app on :5173 + apps/api on :3000 — what you normally want
mise run web          # this app alone (its /api proxy then has nothing to talk to)
```

Vite proxies `/api` to `http://localhost:3000` (override with `API_URL`), so client code uses
the same paths in dev and in production and never branches on a base URL.

Prerequisites: `mise run setup` once (writes `.env`, installs deps, starts Meilisearch, applies
index settings and mints the browser's search key).

> [!TIP]
> With an empty corpus every page works but shows nothing: search returns `total: 0` and the
> home page's Browse rows render no chips, by design — a value with zero documents renders no
> chip rather than a dead link. Fill the index with `mise run pipeline` (needs `GITHUB_TOKEN`).

### Build

```bash
mise run build        # vite build → prerender → typecheck the API
mise run prerender    # re-prerender against the current index, without a fresh bundle
```

Order matters: `vite build` empties `dist/`, so the prerender always runs after it.

### Test, check, lint

```bash
pnpm vitest run apps/web     # this app's suites (5 files, 32 tests)
pnpm -F @keco/web check      # tsc --noEmit
mise run ci                  # what must be green before you call it done
```

Logic lives in plain modules (`lib/topics.ts`, `lib/dates.ts`, `lib/search.ts`,
`prerender/html.ts`) precisely so it can be tested without a DOM. Components hold no logic
worth testing; if one starts to, move the logic out.

### Environment

| Variable | Used for |
|---|---|
| `VITE_MEILI_HOST` | Meilisearch URL the browser talks to |
| `VITE_MEILI_SEARCH_KEY` | Search-only key, scoped to `tools` — `mise run search:key` mints it |
| `API_URL` | Dev-only: where Vite proxies `/api` (default `http://localhost:3000`) |
| `SITE_URL` | Prerender only: canonical URLs and the sitemap |

> [!CAUTION]
> **Vite inlines every `VITE_`-prefixed variable into the bundle at build time.** Anything with
> that prefix is public, permanently, in every deployed artifact. Never give a secret that
> prefix, and never read `process.env` from `src/` expecting it to stay server-side.

## Rules this app is held to

Four of these are enforced by `mise run lint`; the rest by review.

- **`src/` is a browser bundle**: `@keco/core` and `meilisearch` only. No `@keco/query`, no
  `@keco/search` (it carries `createAdminClient`, which reads the master key), no
  `@keco/cache`/`github`/`signals`/`analyze`, no `node:*`. The bundle ships to strangers.
- **`prerender/` is not bundle code.** It may import `@keco/query` to read the read model. It
  may never touch the write side.
- **Never write.** No page mutates anything — not the index, not the cache.
- **Add a client route → check the server fallback.** `/tools/argoproj/argo-cd` resolves on a
  hard refresh only because `apps/api`'s not-found handler falls back to `index.html`. Add a
  route here without confirming that and the URL 404s.
- **Show freshness, don't fake liveness.** Every document carries `indexed_at`; the UI says
  when the data was indexed. `score_momentum` is labelled *momentum*, never "trending this
  week" — there is no time series behind it.
- **Adding a taxonomy family needs no edit here.** The home page and the search page loop over
  `packages/core/taxonomy.yaml`. If you find yourself hardcoding a facet name, stop.
