# @keco/api — the only backend process

Fastify, TypeScript, ESM. One process serves the JSON routes **and** the static portal bundle,
next to Meilisearch and the worker container. It holds the only copy of the Meilisearch master
key and the only cache handle on the read side.

> [!NOTE]
> This app is on the **read side**. It queries the read model and reads the cache by key. The
> one exception is `/api/commands/*`, which appends to the *write* model's journal and never
> touches Meilisearch. See [AGENTS.md](../../AGENTS.md) §2, §11 and §12.

## Architecture

```
                    ┌─────────────────────────────────────────────┐
  browser  ────────▶│  Fastify                                    │
  agents (MCP)      │    /api/v1     ──▶ @keco/query ──▶ Meilisearch `tools`
  backoffice        │    /api/readme ──▶ @keco/cache  ──▶ raw markdown → sanitised HTML
                    │    /api/admin  ──▶ scrypt + signed session cookie
                    │    /api/commands ─▶ journal append (write model)
                    │    /*          ──▶ prerendered HTML, else the SPA shell
                    └─────────────────────────────────────────────┘
```

Three machine front doors — REST, MCP, chat — are **thin adapters over one implementation**,
`@keco/query`. A capability in one and not the others is a bug.

### The two seams

`src/ports.ts` defines the only two ways a route reaches the outside world:

- **`Retrieval`** — `searchTools` + `getTool`, bound to the master-key Meilisearch client.
- **`ReadOnlyCache`** — `getText` + `getJSON`, by key. Nothing in it can write or list; that is
  the CQRS contract expressed as a type rather than a comment.

Both are injectable, which is why **every route test in this app runs without a Meilisearch and
without a `.cache` directory on disk**.

`src/server.ts` builds an instance and never listens; `src/index.ts` is the only thing that
calls `.listen()`. Tests drive the instance through `app.inject()`, so no test opens a socket.

> [!WARNING]
> **Registration order in `server.ts` is load-bearing.** `/api/*` routes register first, then
> `@fastify/static` (with `wildcard: false`, so it cannot claim every unmatched path and shadow
> the JSON routes), then the not-found handler last — it owns the SPA fallback and must see
> everything that did not match above.

### Routes

| Route | Auth | Status |
|---|---|---|
| `GET /api/health` | none | ✅ |
| `GET /api/v1/search` | none, CORS-open, 120/min per IP | ✅ |
| `GET /api/v1/tools/:owner/:repo` | none, CORS-open | ✅ |
| `GET /api/readme/:owner/:repo` | none, 30/min per IP | ✅ |
| `POST /api/admin/login` \| `/logout` \| `GET /session` | session cookie; login 5/min per IP | ✅ |
| `POST /api/commands/:command` | admin session **or** `Bearer $COMMAND_TOKEN`, no CORS | authenticates + validates, then **501** — the journal append is the open piece |
| `POST /api/mcp` | none | stub, **501** |
| `POST /api/chat` | none | stub, **501** |
| `GET /*` | none | prerendered file if the build manifest lists the path, else `index.html` |
| `GET /admin` | — | `noindex` 404 until `apps/backoffice` exists |

The commands vocabulary is closed: `recrawl` · `reanalyze` · `reproject` · `rebuild` ·
`rollback`. An unknown one is a 400 with the list.

### Rate limits are per-route and deliberately unequal

They are measured, not guessed, and the differences are the point — do not "harmonise" them:

| Route | Budget | Why |
|---|---|---|
| `/api/v1/*` | 120/min | Read-only Meilisearch lookups, no CPU-bound work behind them |
| `/api/readme/*` | 30/min | Runs the full markdown → sanitize → Shiki pipeline; up to ~1.4s of single-threaded CPU per hit. Response capped at 64 KB of source, `truncated: true` beyond it |
| `/api/admin/login` | 5/min | `crypto.scrypt` runs on the libuv threadpool (4 slots by default), shared with every file read this process performs. An unthrottled login flood starves static serving too |

### README rendering

`GET /api/readme/:owner/:repo` reads the cached markdown by key and returns sanitised HTML:
`remark-parse` → `remark-gfm` → `remark-rehype` → `rehype-raw` → **`rehype-sanitize`** →
`@shikijs/rehype` → `rehype-stringify`, with relative image/link URLs rewritten against
`image_base_url` and the top badge-only paragraph stripped.

> [!CAUTION]
> README markdown is **untrusted input** from 30k strangers' repositories. The sanitise step is
> not optional, and `image_base_url` is validated with zod before it reaches a `src`/`href` —
> an unvalidated cast there is a base-URL-controlled open redirect and local-file read waiting
> to happen (`new URL(rel, 'file:///etc/')` parses just fine).

The cache key is built from path parameters, so the owner/repo vocabulary is pinned to what
GitHub actually allows. Without that, `..%2f..%2f` reads arbitrary blobs.

## Development

```bash
mise run dev     # this app on :3000 + the portal on :5173 with HMR
mise run api     # this app alone — serves apps/web/dist if you have built it
```

`dev` runs `node --import tsx --watch`, so edits restart the process.

Prerequisites: `mise run setup` once, and Meilisearch running (`mise run infra:up`).

```bash
mise run admin:hash -- --password 'something long'   # → ADMIN_PASSWORD_HASH
```

### Test, check, lint

```bash
pnpm vitest run apps/api     # this app's suites (10 files, 91 tests)
pnpm -F @keco/api check      # tsc --noEmit
mise run ci                  # what must be green before you call it done
```

No test needs a running Meilisearch, a `.cache` directory, or a free port — inject the two
ports from `ports.ts` and drive the instance with `app.inject()`. If a new test wants a real
dependency, the seam is missing, not the test.

### Environment

Validated with zod at boot (`src/env.ts`) — a bad environment fails the process immediately
rather than at the first request.

| Variable | Default | Used for |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | The listener |
| `SITE_URL` | `http://localhost:3000` | Canonical links; the session cookie's `Secure` flag |
| `TRUST_PROXY` | `false` | Only `true` behind a reverse proxy **you control** — it decides where `request.ip` (and so every rate limiter) reads its address from |
| `MEILI_HOST` | `http://localhost:7700` | Read model |
| `MEILI_MASTER_KEY` | *required* | Server-side only. Never `VITE_`-prefixed, never in a bundle |
| `CACHE_DIR` | `.cache` | The write model, read here **by key only** |
| `WEB_DIST` | `apps/web/dist` | The portal bundle this process serves |
| `SESSION_SECRET` | *required, ≥32 chars* | Signs the admin session cookie |
| `ADMIN_PASSWORD_HASH` | optional | `scrypt$salt$key` — without it, admin login is unavailable |
| `COMMAND_TOKEN` | optional | `/api/commands/*` without an admin session |
| `LOG_LEVEL` | `info` | pino |

## Rules this app is held to

- **Never write a read model.** Not a page, not a route, not a tool. `/api/commands/*` writes
  to the *write* model (a journal event or a checkpoint reset) and is the only exception.
- **No long work in a request handler.** Handlers enqueue; workers execute. A `for` loop over
  10k repos in this app is always a bug — there is no background runtime here, and the request
  will time out before it finishes.
- **Import boundary** (enforced by lint): `@keco/query`, `@keco/core`, `@keco/cache`,
  `@keco/search` — never `@keco/github`, `@keco/signals` or `@keco/analyze`. This process does
  not fetch from third parties; that is the write side's job, and its quota.
- **Authorize inside every handler**, not only in a plugin hook. A route that trusts an
  upstream guard is one refactor away from being unguarded.
- **Validate at the boundary with zod**, per route. `routes/readme.ts` and `routes/admin.ts`
  are the pattern.
- **Errors never leak internals.** `rootErrorHandler` is set before any route group registers,
  so nothing can fall through to Fastify's default serializer and echo an `error.message`.
- **REST and MCP move together.** A contract change lands in `@keco/core` and is reflected in
  both, or it is not done.
