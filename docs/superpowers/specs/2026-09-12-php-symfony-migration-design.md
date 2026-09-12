# PHP 8 / Symfony 8 monolith — architecture and file layout

**Date:** 2026-09-12
**Status:** approved, not implemented
**Touches:** everything under `apps/api`, `apps/workers`, `packages/*`; adds `backend/`,
`taxonomy/`; leaves `apps/web` in place
**Related:** `docs/adr/0005-php-symfony-monolith.md` (the decision this implements),
`docs/adr/0001` (partially superseded), `docs/adr/0002` (retired), `AGENTS.md` (rewritten
alongside this spec)

This is the architecture and directory layout for the PHP rewrite. It does not implement
anything — per the working agreement, code follows in a separate pass, package by package,
each with its own plan under `docs/superpowers/plans/`. This spec is what those plans build
against, and what `AGENTS.md` §2–§14 now describes as current.

## 0. What stays true, restated once

Everything in `AGENTS.md` §1–§2 before this migration is still the target: Keco is a search
portal derived entirely from public GitHub data, CQRS separates commands from queries, read
models are disposable, and the write side never reads a read model. Nothing here reopens that.
What changes is the two things ADR 0001 tied to "no framework": the write model's storage
(filesystem → Postgres + a narrower blob store) and the process model workers run under
(four Node scripts under node-cron → one Symfony app's console commands + Messenger consumers).

## 1. Repository layout

```
keco/
├── apps/
│   └── web/                        # UNCHANGED — portal SPA, Vite + React, Node build/prerender/e2e
├── backend/                        # NEW — the Symfony 8 monolith: former apps/api + apps/workers
│   │                                 + every packages/* write-side package + the backoffice
│   ├── bin/console
│   ├── config/
│   │   ├── packages/                 doctrine.yaml, messenger.yaml, easy_admin.yaml,
│   │   │                             security.yaml, rate_limiter.yaml, scheduler.yaml,
│   │   │                             http_client.yaml, html_sanitizer.yaml
│   │   ├── routes.yaml
│   │   └── services.yaml
│   ├── migrations/                   # Doctrine migrations — the schema's only history
│   ├── public/
│   │   └── index.php                 # the one front controller
│   ├── src/
│   │   ├── Kernel.php
│   │   ├── Entity/                   # Doctrine entities — the write model, §3
│   │   ├── Repository/               # one Doctrine repository per entity
│   │   ├── Blob/                     # BlobStorageInterface + Local/S3 adapters, §3.1
│   │   ├── Journal/                  # JournalEvent + Checkpoint helpers, shared by every consumer
│   │   ├── Discovery/                # write side, §4.1
│   │   │   ├── Message/  MessageHandler/  Console/
│   │   ├── Crawler/                  # write side, §4.2
│   │   │   ├── Message/  MessageHandler/  Icon/  Console/
│   │   ├── Analyzer/                 # write side, §4.3
│   │   │   ├── Rules/  Signals/  Llm/  Message/  MessageHandler/  Console/
│   │   ├── Projector/                # write side, §4.4
│   │   │   ├── Scoring/  Message/  MessageHandler/  Console/
│   │   ├── Taxonomy/                 # taxonomy.yaml loader + validation, §6
│   │   ├── Search/                   # Meilisearch client wrapper, index defs/settings, §5
│   │   ├── Query/                    # the shared retrieval layer, §11 (SearchTools, GetTool, …)
│   │   ├── Api/
│   │   │   ├── Controller/           V1Controller, McpController, ChatController,
│   │   │   │                        ReadmeController, IconController, AdminAuthController,
│   │   │   │                        CommandsController
│   │   │   └── Security/             AdminAuthenticator, CommandTokenAuthenticator
│   │   ├── Backoffice/
│   │   │   └── Controller/Admin/     DashboardController + read-only CRUD controllers, §10
│   │   └── Command/                  cross-cutting console commands: taxonomy:check,
│   │                                 search:settings, search:key, index:create, index:seed,
│   │                                 checkpoint:reset
│   ├── tests/
│   │   ├── Unit/  Functional/  Fixtures/    # Fixtures/ mirrors packages/analyze/fixtures — real
│   │   │                                     cached GitHub payloads, committed
│   ├── var/                          # framework cache/log dir
│   ├── composer.json
│   ├── phpunit.xml.dist
│   ├── deptrac.yaml                  # import-boundary enforcement, §7 — the PHP eslint.config.mjs
│   └── phpstan.neon
├── taxonomy/
│   └── taxonomy.yaml                 # MOVED from packages/core — the one file both backend/ (PHP)
│                                     # and apps/web (JS) load, unchanged shape, §6
├── infra/
│   ├── compose.yml                   # + postgres, php app, worker containers (was Meilisearch-only)
│   └── docker/  php.Dockerfile  worker.Dockerfile
├── docs/adr/, docs/superpowers/      # unchanged conventions
├── mise.toml                         # retargeted: composer/console instead of pnpm scripts
└── AGENTS.md
```

`packages/*` and `apps/workers` are deleted once `backend/` reaches parity, package by package —
not kept as a permanent second implementation (ADR 0005, "Consequences").

## 2. Runtime processes

One deployable, matching §7's "one Node process in production" ethos, now four kinds of process
from one codebase:

| Process | Runs | Replaces |
|---|---|---|
| **web** | FrankenPHP (or php-fpm + nginx), serving `/api/*` and `/admin` | `apps/api` (Fastify) |
| **worker: discovery** | `bin/console messenger:consume async_discovery` | discovery's node-cron loop |
| **worker: crawler** | `bin/console messenger:consume async_crawl` | crawler's node-cron loop |
| **worker: analyzer** | `bin/console messenger:consume async_analyze` | analyzer's node-cron loop |
| **worker: projector** | `bin/console messenger:consume async_project` | projector's node-cron loop |
| **scheduler** | `bin/console messenger:consume scheduler_default` (Symfony Scheduler) or system cron calling `bin/console app:discovery:sweep` etc. | node-cron's cadence trigger |

Each worker transport is independent — no cross-transport imports, mirroring "workers never talk
to each other" (§4). Concurrency that used to be `p-queue(≈8)` is now replica count: run N
instances of a given `messenger:consume` unit (`docker compose up --scale worker-crawler=8`).
Retry that used to be `p-retry` is Messenger's own `retry_strategy` (max_retries, exponential
multiplier) configured per transport in `config/packages/messenger.yaml`.

**Sharding is retired.** The old deterministic `hash(repo) % SHARD_COUNT` existed because there
was no coordination primitive over a filesystem. The Doctrine Messenger transport dequeues with
row-level locking (`FOR UPDATE SKIP LOCKED`-equivalent), so multiple consumer processes on one
transport already split work safely. Don't reintroduce a hash partition on top of it.

## 3. The write model (Postgres via Doctrine)

Structured, queryable write-model data — the direct replacement for `repos/**`, `analysis/**`,
`journal/**`, `checkpoints/**` and the `discovery_*`/`crawl_history` Meilisearch collections:

| Entity | Replaces | Notes |
|---|---|---|
| `Repo` | `repos/{owner}/{repo}/repo.json` + `_fetch.json` | Typed columns for what's scored/filtered/queried (`stars`, `forks`, `pushed_at`, `archived`, `license`, `content_hash`, `etag`, `fetched_at`); `raw_payload jsonb` keeps the **verbatim** GitHub API response — the same non-negotiable §3 rule, now a jsonb column instead of a file. `tree jsonb` and `manifests jsonb` (path ⇒ content) hold what pass-1 rules inspect. |
| `Analysis` | `analysis/{owner}/{repo}.json` | `kind`, `domains[]`, `runtime`, `license_class`, `openness`, `maturity`, `governance`, `confidence`, `method`, `model`, `signals jsonb`, `signals_used[]`, `partial_signals[]`, `content_hash`, `analyzed_at`. |
| `JournalEvent` | `journal/{date}/{ulid}.json` | `id` (ULID, PK, sortable), `type`, `repo` (nullable), `payload jsonb`, `created_at`. Append-only; never updated or deleted (§2 rule 7). An indexed range query (`WHERE id > :checkpoint ORDER BY id LIMIT :n`) replaces the old directory-of-files-by-ULID scan — strictly the same "never LIST to find work" contract, backed by a real index instead of a convention. |
| `Checkpoint` | `checkpoints/{consumer}.json` | `consumer_name` (PK), `last_event_id`, `updated_at`. |
| `DiscoveryRepo` | `discovery_repos` (Meilisearch) | Discovery's corpus. |
| `DiscoveryRun` | `discovery_runs` (Meilisearch) | One row per sweep process; `outcome` (`running`/`complete`/`failed`/`interrupted`) exactly as before. |
| `DiscoveryState` | `discovery_state` (Meilisearch) | Resume position, one per query. |
| `CrawlHistoryEntry` | `crawl_history` (Meilisearch) | One row per crawl run. |
| `ExternalSignal` | `external/{provider}/{key}.json` | `provider`, `cache_key`, `payload jsonb`, `fetched_at`, `ttl_seconds` — the pass-2 provider cache. Postgres instead of files buys an indexed `(provider, cache_key)` lookup and a trivial "everything past its TTL" query for refresh sweeps. |
| `ChatTrace` | `traces` (Meilisearch) | `(query, retrieved_ids, answer, created_at)` — moved out of Meilisearch because it was never searched, only listed for eval fixtures; a relational log is the honest fit. |

This retires ADR 0002's `DataStore` port and its three implementations. Discovery, crawler,
analyzer and projector all depend on Doctrine repositories directly — the same way every other
worker already depended on `Storage` for `repos/**`. Doctrine's `EntityRepository` *is* the
abstraction; a second hand-rolled port over it would duplicate what the ORM already provides. See
ADR 0005 §5 for why this is a retirement, not a migration.

**Meilisearch shrinks to one real job**: the `tools` search index. `repos_state` and `traces`
existed only because there was nowhere else to put queryable-but-not-searched data; now there is.

### 3.1 The blob store — what still isn't a database row

A `BlobStorageInterface` (Flysystem, local adapter today, swappable to S3 later — the direct
descendant of `Storage`) holds exactly what doesn't belong in a jsonb column:

- `repos/{owner}/{repo}/readme.md` — raw markdown, can be large, never queried by field.
- `repos/{owner}/{repo}/icon.src` and derived `icon-{32,64,160}.png` — binary.

Everything else that used to be a small JSON file (`repo.json`, `tree.json`, `manifests/*`,
`external/*`) becomes a jsonb column or table per §3 above, because it's structured and it is
now genuinely useful to query it that way (e.g. "every repo whose Scorecard entry is older than
7 days"). The blob store is deliberately narrow — resist the urge to put structured data back
into it just because the old system did; that was a constraint of not having Postgres, not a
design goal in itself.

## 4. Message flow (replaces the journal-as-coordination-mechanism)

The journal (`JournalEvent` table) is still the durable record of what happened — replay reads
it, exactly as §2 describes. Messenger adds a *dispatch* layer on top for triggering work,
matching the original event types one-to-one:

```
SweepDiscoveryQuery (scheduled)
  → DiscoverySweepHandler → upserts DiscoveryRepo rows, records DiscoveryRun/DiscoveryState

CrawlRepo(owner, name)                          [dispatched per DiscoveryRepo, batched]
  → CrawlRepoHandler → fetches GitHub (conditional), writes Repo row + blob store,
    appends JournalEvent{type: RepoFetched, changed}
    → if changed: dispatches AnalyzeRepo(owner, name)

AnalyzeRepo(owner, name)
  → AnalyzeRepoHandler → pass 1 rules → pass 2 signals → pass 3 LLM fallback,
    writes Analysis row, appends JournalEvent{type: RepoAnalyzed, confidence}
    → dispatches ProjectRepo(owner, name)

ProjectRepo(owner, name)
  → ProjectRepoHandler → reads Repo + Analysis, computes scores, upserts one `tools` document,
    waits for the Meilisearch task before returning (§5's hard rule, unchanged)
```

A repo that fails at any stage: the handler catches it, appends `JournalEvent{type: RepoFailed,
phase, error}`, and does **not** rethrow into Messenger's retry — a single bad repo must never
retry-storm or dead-letter-queue-block the transport (§13's rule, restated for this runtime). A
provider that degrades (pass 2) still writes `Analysis` with `partial: true` and moves on (§4.3).

`RepoSkipped` keeps its meaning unchanged — the crawler decides from `Repo.raw_payload` alone
(forks, archived+stale) and appends the event instead of dispatching `AnalyzeRepo`.

## 5. Commands (`/api/commands/*` and the backoffice's action buttons)

One `CommandDispatcher` service, used by both `Api\Controller\CommandsController` (external,
admin-session-or-bearer-token gated) and `Backoffice\Controller\Admin\*` custom actions (internal,
already behind the `/admin` firewall). It does exactly two things, matching §11 word for word:

- appends a `JournalEvent` and/or dispatches a Messenger message (`RequestRecrawl`,
  `RequestReanalysis`, `RequestIndexRebuild`, …);
- resets a `Checkpoint` row.

It never touches `Search` (Meilisearch write) and never loops over repos synchronously — the
handler that eventually processes the dispatched message does the fan-out, in the worker
process, not inside the request. A route handler that iterates repos is still always a bug.

## 6. Import boundaries — `deptrac.yaml` replaces `eslint.config.mjs`'s rules

One rule per §7 boundary, checked by `mise run check` (translated to run `deptrac analyse`):

- `Discovery`, `Crawler`, `Analyzer`, `Projector` may depend on `Entity`, `Repository`, `Blob`,
  `Journal`, `Taxonomy` — never on `Search` or `Query`.
- `Search` and `Query` may be imported only by `Projector` (write, for upserts) and `Api`/
  `Backoffice` (read). `Query` never imports `Entity`/`Repository`/`Blob` — it only ever talks to
  `Search`, mirroring the old "`packages/query` may import `@keco/search`, never `@keco/cache`"
  rule exactly.
- `Api` and `Backoffice` may depend on `Query`, `Entity`/`Repository` (read-only queries for
  observability — `repos_state`'s replacement), `Journal` (checkpoint reset) and
  `CommandDispatcher` — never on `Discovery`, `Crawler`, `Analyzer` or `Signals` directly. The
  only way the read side reaches the write side is through a dispatched message.
- `Analyzer\Signals` may only be imported by `Analyzer` itself, and every adapter goes through
  `ExternalSignal`'s cache-first repository — a provider called without the cache in front of it
  is a bug, unchanged from §4.3.

## 7. What replaces each library

| Node/TS | PHP/Symfony | Notes |
|---|---|---|
| zod | Symfony Validator + typed DTOs/entities | Boundary validation stays mandatory (§13); `any` maps to forbidding `mixed` outside the verbatim `raw_payload` column. |
| `p-queue` / `p-retry` | Messenger transports + `retry_strategy` | §2. |
| node-cron | Symfony Scheduler, or system cron calling `bin/console` | §2. |
| custom GitHub REST client + pacer | `HttpClient` + Symfony `RateLimiter` component | ADR 0003's REST-not-GraphQL and conditional-request rules are unchanged, just re-implemented. |
| `sharp` (icon rasterization) | Imagick (with the SVG delegate) or `intervention/image` | Rasterize-as-sanitize, §9's rule, unchanged. |
| `rehype-sanitize` (README HTML) | `symfony/html-sanitizer` | Same server-side-only rule (§9, §14): never render raw README markdown client-side. |
| Shiki (syntax highlighting) | `scrivo/highlight.php` (or an equivalent PHP highlighter) | Applied server-side in the README pipeline, same as before. |
| Anthropic SDK (pass 3) | `HttpClient` against the Anthropic Messages API directly | Structured output still validated before use; invalid → retry once → the same `service`/`0.3`/`needs_review:true` fallback (§4.3). |
| Meilisearch JS client | `meilisearch/meilisearch-php` | Same index defs, same hard rules (§5): async writes awaited, shallow-merge danger on `updateDocuments`, alias swap only. |
| `@keco/core`'s taxonomy loader | PHP YAML component + a validation pass, run by both backend and (via an equivalent JS loader) `apps/web` | See §8, the one real cost of this split. |

## 8. What this split costs — the filter-building algebra

`@keco/core` let `apps/web` (browser) and `apps/api` (Node) share one literal implementation of
`buildFilters`, `selectionFromParams`, `defaultFacets`, `familyAttribute` and the sort-key
vocabulary — because both were TypeScript. That is no longer possible once the backend is PHP:
the portal still needs this exact algebra client-side (§9 — browser-direct Meilisearch queries,
no round trip), and the backend needs the same algebra for REST/MCP/chat.

The fix is duplication with a guardrail, not a workaround that reintroduces a network round trip
into the portal's search-as-you-type path: a language-agnostic fixture file (JSON: given these
URL params, expect this Meilisearch filter string / these facets / this sort key) lives at
`taxonomy/query-fixtures.json`, next to the taxonomy it's derived from, and both `apps/web`'s
test suite and `backend/tests/Unit`'s test suite assert against it. A rule change ships as one
fixture edit that fails in both suites until both implementations are updated — the closest
equivalent to "one source of truth" available across a language boundary. This is recorded in
`AGENTS.md`'s "things that will bite you" as a standing risk, not solved once and forgotten.

## 9. What is explicitly out of scope for this spec

- Writing any PHP code. This spec is what the follow-up plans (one per bounded context: entities
  + migrations first, then `Journal`/`Blob`, then `Discovery`, `Crawler`, `Analyzer`, `Projector`,
  then `Api`, then `Backoffice`) build against.
- Deciding Pest vs. PHPUnit. Symfony's own default (PHPUnit via `symfony/test-pack`) is assumed
  until a plan says otherwise; either is compatible with everything above.
- Re-litigating whether `apps/web` should ever become a Symfony/Twig app. ADR 0005 records that
  as a deliberate non-goal for this migration.
