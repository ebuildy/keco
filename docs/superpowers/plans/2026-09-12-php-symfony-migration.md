# PHP/Symfony migration — phased plan

**Date:** 2026-09-12
**Status:** approved, not started — planning only, no code written yet
**Touches:** adds `backend/` (new Symfony app, composer package `keco/backend`); leaves
`apps/web`, `apps/api`, `apps/workers`, `packages/*` untouched throughout every phase below
**Related:** `docs/adr/0005-php-symfony-monolith.md` (the decision),
`docs/superpowers/specs/2026-09-12-php-symfony-migration-design.md` (the architecture this
implements), `AGENTS.md` (the contract this migration is building toward)

## Summary

Five phases, in order, each landing a working slice of `backend/` without touching or deleting
any existing TypeScript. Phase order follows the pipeline's own dependency order (discovery feeds
crawler, crawler feeds analyzer), with the backoffice last because it's the first thing that reads
across all three.

## Ground rules for every phase

- **No TypeScript is deleted in phases 0–4.** `apps/workers`, `apps/api` and every `packages/*`
  package keep running exactly as they do today. Retiring a TS component is a separate, later,
  explicitly-approved step per component — never a side effect of a PHP phase reaching parity.
- **Only `backend/` is touched.** `mise.toml`, `infra/compose.yml`, root `package.json`,
  `eslint.config.mjs`, `pnpm-workspace.yaml` are not edited by any phase in this plan. Where a
  phase needs something those files would normally provide (a local Postgres, a task runner
  entrypoint), it gets a self-contained equivalent inside `backend/` instead (e.g. a
  `backend/compose.yaml` for local Postgres, `composer.json` scripts as the task runner). Wiring
  `backend/` into the root `mise.toml` and `infra/compose.yml` is a deliberate, separate step for
  after phase 4, not bundled into any phase here.
- **Composer package name: `keco/backend`.** PHP namespace stays Symfony's conventional `App\` —
  no reason to fight bundle recipes and skeleton defaults over branding; "keco" is the
  project/composer identity, not the PHP namespace.
- **Each phase gets its own spec + plan pair** under `docs/superpowers/specs/` and
  `docs/superpowers/plans/` when its turn comes to be executed — the same convention
  `discovery-worker`, `crawler` and `analyzer` already follow for the TS implementation. This
  document is the roadmap tying them together, not a replacement for that per-phase detail.
- **Every phase ends at a real gate**: PHPUnit green, PHPStan max level clean, `deptrac analyse`
  clean, and — from phase 1 onward — a parity check against the equivalent TS component (same
  input, same output, run side by side) before the phase is called done.

## Phase 0 — Bootstrap the Symfony backend app ("keco")

**Scope IN:** the skeleton, the dependencies, the shared plumbing every later phase needs, and
nothing that encodes a single business rule yet.

- `composer create-project symfony/skeleton backend`, package name `keco/backend`.
- Dependencies: `doctrine/orm` + `doctrine/doctrine-bundle` + `doctrine/doctrine-migrations-bundle`
  (write model, §3), `symfony/messenger` (§4), `symfony/scheduler` (cadence), `symfony/http-client`
  (every outbound call), `symfony/rate-limiter` (GitHub pacing), `symfony/html-sanitizer` (README,
  later phase), `symfony/uid` (ULIDs for `JournalEvent`), `symfony/validator`,
  `symfony/security-bundle` (admin auth, later phase), `symfony/twig-bundle` (EasyAdmin needs it),
  `meilisearch/meilisearch-php` (projector/query, later phase — added now so `Search` namespace
  can be scaffolded, not wired).
- Dev dependencies: `symfony/test-pack` (PHPUnit), `phpstan/phpstan` + `phpstan-doctrine` +
  `phpstan-symfony` at max level, `friendsofphp/php-cs-fixer`, `qossmic/deptrac-src`.
- `backend/compose.yaml`: a local Postgres service, self-contained to this app (per "ground
  rules" above — the root `infra/compose.yml` is not touched in this phase).
- Shared plumbing, with no dependents yet but exercised by their own unit tests:
  - `Journal\JournalEvent` entity + migration, `Journal\Checkpoint` entity + migration, and a
    `Journal\JournalWriter`/`JournalReader` pair implementing the append + indexed-range-read
    contract from AGENTS.md §3.
  - `Blob\BlobStorageInterface` + a local Flysystem adapter (§3.1).
  - `Taxonomy\TaxonomyLoader` reading `taxonomy/taxonomy.yaml` (moved to the repo root as part of
    this phase, since nothing else references its old `packages/core` location yet) and
    `bin/console app:taxonomy:check`.
- The namespace skeleton from the design spec's §1 tree: `Entity/`, `Repository/`, `Blob/`,
  `Journal/`, `Discovery/`, `Crawler/`, `Analyzer/` (with `Rules/`, `Signals/`, `Llm/`),
  `Projector/`, `Taxonomy/`, `Search/`, `Query/`, `Api/`, `Backoffice/`, `Command/` — created even
  where empty, so the tree matches AGENTS.md §7 from day one.
- `deptrac.yaml` with the layer rules from AGENTS.md §7 / design spec §6, checked against the
  (mostly empty) skeleton.
- `backend/.env` + `backend/.env.local.dist` (or `.env.test`) with placeholders for every variable
  named in AGENTS.md §12, each with a comment naming which later phase actually reads it.

**Scope OUT:** any entity beyond `JournalEvent`/`Checkpoint`, any Messenger transport wired to a
real handler, any controller, EasyAdmin, security, actually calling GitHub or Meilisearch.

**Acceptance criteria:**
- [ ] `composer install` succeeds from a clean clone.
- [ ] `bin/console about` runs.
- [ ] `docker compose -f backend/compose.yaml up -d` + `bin/console doctrine:database:create` +
      `bin/console doctrine:migrations:migrate` succeed against local Postgres.
- [ ] `vendor/bin/phpstan analyse` clean at max level.
- [ ] `vendor/bin/deptrac analyse` clean.
- [ ] `vendor/bin/phpunit` green (covering `Journal`, `Blob`, `Taxonomy` — the only real code yet).
- [ ] `bin/console app:taxonomy:check` validates `taxonomy/taxonomy.yaml` and fails loudly on a
      deliberately-broken copy (proving the validation isn't a no-op).
- [ ] Directory tree under `backend/src` matches AGENTS.md §7.

## Phase 1 — Migrate discovery

**Scope IN:** everything in AGENTS.md §4.1, ported from `apps/workers/src/discovery`.

- Entities: `DiscoveryRepo`, `DiscoveryRun`, `DiscoveryState` + migration.
- The window/plan/sweep algebra (`windows.ts`/`plan.ts`/`sweep.ts` today) as pure PHP classes
  under `Discovery/`, unit-testable with no Postgres — ported test-by-test from the existing TS
  test suite so behavior parity is provable, not assumed.
- A GitHub Search client over `HttpClient`, paced by `RateLimiter` (its own budget, separate from
  the crawler's — AGENTS.md §4.1's "own rate pacer" rule).
- `Discovery\Message\SweepDiscoveryQuery` + handler, dispatched by Scheduler/cron.
- Console commands: `app:discovery:sweep`, `app:discovery:list`, `app:discovery:reset`, matching
  today's `kecoctl discovery *` flag surface (`--fresh`, `--limit`, `--query`).

**Scope OUT:** the crawler reading `DiscoveryRepo` (phase 2); anything in `Crawler`/`Analyzer`.

**Dependencies:** phase 0's `Journal`, `Taxonomy` (unused here, but the namespace convention),
and Postgres migrations tooling.

**Acceptance criteria:**
- [ ] Running `app:discovery:sweep --query kubernetes --limit 3` against a fresh Postgres and the
      real GitHub Search API produces a `DiscoveryRepo` set that matches (same repo count, same
      windows completed) a same-parameters run of today's `mise run discovery:sweep` — the parity
      check named in "Ground rules."
- [ ] `--fresh` deletes and re-populates as AGENTS.md §4.1 describes; `--limit` overshoots at the
      next window boundary, matching today's documented behavior.
- [ ] A killed process leaves its `DiscoveryRun` row at `running` (the deliberate-stuck-row
      behavior), verified by a test that kills the process mid-sweep.
- [ ] PHPUnit, PHPStan, deptrac all green.

## Phase 2 — Migrate crawler

**Scope IN:** everything in AGENTS.md §4.2, ported from `apps/workers/src/crawler`.

- `Repo` entity + migration (typed columns + `raw_payload`/`tree`/`manifests` jsonb, §3).
- `CrawlHistoryEntry` entity + migration.
- Blob store wiring for `readme.md`, `icon.src`, derived PNGs (Phase 0's `BlobStorageInterface`,
  now with a real writer).
- Icon rasterization via Imagick (replacing `sharp`) — same "rasterize is the sanitize" contract.
- `HttpClient`-based GitHub REST client: conditional requests (`ETag`/`If-None-Match`), 403/429
  backoff, `retry-after` handling — porting `docs/adr/0003-crawler-rest-not-graphql.md`'s
  reasoning unchanged.
- Skip rules (forks, archived+stale) decided from `raw_payload` alone, `JournalEvent{RepoSkipped}`
  with a reason.
- `Crawler\Message\CrawlRepo` + handler, dispatched per `DiscoveryRepo` row (batched, not one
  dispatch per repo per tick — match today's `--limit` batching behavior).
- Console commands: `app:repo:crawl`, `app:repo:icon`, `app:repo:history`.

**Scope OUT:** analysis of any kind; `AnalyzeRepo` dispatch can be stubbed (logged, not sent)
until phase 3 exists — a `RepoFetched{changed: true}` event is still appended even though nothing
yet consumes it to analyze.

**Dependencies:** phase 1's `DiscoveryRepo` table as the worklist; phase 0's `Blob`, `Journal`.

**Acceptance criteria:**
- [ ] Crawling the same 50-repo sample with the PHP crawler and with `mise run repo:crawl`
      produces matching `Repo` rows / cache entries for stars, license, archived, content hash,
      and matching `RepoSkipped` decisions for the sample's forks/archived repos.
- [ ] A 304 response short-circuits to `RepoFetched{changed: false}` with zero extra requests,
      verified against a recorded fixture (no live GitHub call in the test).
- [ ] Icon rasterization produces byte-for-byte-equivalent-enough (visually, at minimum correct
      dimensions and format) PNGs to the `sharp` pipeline for a fixed sample of source icons.
- [ ] PHPUnit, PHPStan, deptrac all green; `GITHUB_QUOTA_CRAWLER_SHARE` respected in a test that
      simulates a shared budget.

## Phase 3 — Migrate analyzer

**Scope IN:** everything in AGENTS.md §4.3, ported from `packages/analyze` + `packages/signals`.

- `Analysis` entity + migration, `ExternalSignal` entity + migration.
- Pass 1 rules as one PHP class per rule under `Analyzer/Rules`, each with a fixture in
  `backend/tests/Fixtures` ported from `packages/analyze/fixtures/*.json` — same repos, same
  expected output, proving parity fixture-by-fixture rather than by spot check.
  `backend/tests/Unit/RulesPinningTest.php` replaces `pinning.test.ts`: every value a rule can
  emit must exist in `taxonomy/taxonomy.yaml`.
- Pass 2 signal adapters under `Analyzer/Signals` (Scorecard, deps.dev, OSV, Homebrew, krew index,
  Artifact Hub, OperatorHub, CNCF Landscape) — each cache-first through `ExternalSignal`, each
  degrade-never-fail with `partial_signals[]`.
- Pass 3 LLM fallback under `Analyzer/Llm`: `HttpClient` against the Anthropic Messages API,
  structured output validated by a DTO + Validator refinement against the taxonomy, one retry,
  then the `service`/`0.3`/`needs_review:true` fallback.
- `Analyzer\Message\AnalyzeRepo` + handler, dispatched on `RepoFetched{changed:true}` (wiring the
  stub from phase 2) or an expired `ExternalSignal.ttl_seconds`.
- Console commands: `app:repo:analyze` with `--force-refresh <provider>`, `--repo <owner/name>`,
  `--min-confidence`.

**Scope OUT:** the projector; `ProjectRepo` dispatch can be stubbed the same way `AnalyzeRepo` was
in phase 2.

**Dependencies:** phase 2's `Repo` rows and blob-stored README/tree.

**Acceptance criteria:**
- [ ] Every ported fixture classifies identically to its TS counterpart (`kind`, `domains`,
      `runtime`, `license_class`, `openness`, `maturity`, `governance`, `k8s_relevance`) — a
      diffed table of "TS output vs. PHP output" per fixture, zero unexplained differences.
- [ ] A provider timeout/404/rate-limit produces `signals.{provider} = null` +
      `partial_signals[]` and the analysis still writes (degrade-never-fail, tested per provider).
- [ ] Pass 3 is invoked only when confidence < 0.7 or `kind` is ambiguous, verified by a test
      asserting pass 1/2 alone settle the fixture set's non-ambiguous cases without an LLM call.
- [ ] PHPUnit, PHPStan, deptrac all green.

## Phase 4 — Create a backoffice

**Scope IN:** everything in AGENTS.md §10, net-new (there is no TS equivalent to port — the old
`apps/backoffice` was never built).

- EasyAdminBundle install, `DashboardController` at `/admin`.
- Read-only `CrudController`s over `Repo`, `Analysis`, `JournalEvent`, `DiscoveryRun`,
  `CrawlHistoryEntry` — `NEW`/`EDIT`/`DELETE` explicitly disabled on every one (AGENTS.md §10's
  "active resistance" rule; a test asserts this for every registered controller so a future
  addition can't silently skip it).
- Admin auth: a custom Symfony authenticator against `ADMIN_PASSWORD_HASH`
  (`symfony/password-hasher`, constant-time comparison), signed `HttpOnly`/`SameSite=Strict`
  session cookie — no OAuth, matching AGENTS.md §12.
- `CommandDispatcher` service (AGENTS.md §11): appends a `JournalEvent` and/or dispatches a
  Messenger message, never does work inline. Wired to EasyAdmin custom actions for: re-crawl one
  repo, re-analyze one repo, re-analyze everything below a confidence threshold, and a checkpoint
  reset action.
- Pipeline health view: counts by phase, failures, skip reasons, confidence distribution,
  checkpoint lag per consumer — all read from Doctrine directly, no Meilisearch dependency.

**Scope OUT, explicitly flagged, not silently dropped:** rebuilding the search index and viewing
taxonomy facet counts both need the projector and `Search`/`tools`, which are **not** in this
five-phase plan (see "What this plan does not cover" below). Their buttons/panels ship visibly
disabled with a "not available until the projector is migrated" state rather than being wired to
nothing, or omitted entirely from phase 4 and added when that dependency exists — pick one when
this phase's own detailed plan is written; either is acceptable, silently faking the data is not.

**Dependencies:** phases 1–3's entities, for the pipeline-health and repo-inspector views to have
real data to show.

**Acceptance criteria:**
- [ ] Every registered `CrudController` has `NEW`/`EDIT`/`DELETE` disabled — enforced by a test
      that iterates all registered controllers and asserts this, not just checked by review.
- [ ] Login works with the constant-time credential check; a wrong password does not leak timing
      or an informative error.
- [ ] A command action returns immediately (no synchronous loop over repos in the request) and
      the dispatched message is verifiable in a functional test using Messenger's in-memory
      transport.
- [ ] Pipeline-health counts match a hand-computed expectation over seeded `Repo`/`Analysis`/
      `JournalEvent` fixture data.
- [ ] PHPUnit (including functional/`WebTestCase` coverage of the admin routes), PHPStan, deptrac
      all green.

## What this plan does not cover

Named explicitly so it isn't mistaken for an oversight:

- **The projector** (AGENTS.md §4.4) and **the public API** (`Api\Controller`: REST v1, MCP,
  chat, readme, icon, commands — AGENTS.md §11) are not phases in this plan. Until they're
  migrated, `apps/api` (Fastify) keeps serving the portal's README/icon/chat endpoints and the
  public REST/MCP surface, and **the `tools` Meilisearch index keeps being written by the
  existing TS projector, not by `backend/`.** Phase 4's backoffice reads Postgres directly and
  needs neither.
- **Retiring any TS component.** Every phase above adds a PHP implementation; none of them remove
  the TS one. A follow-up plan, written once phase 4 is done and a projector/API migration is
  scoped, decides retirement order and is the first point at which any `packages/*` or
  `apps/workers` code is deleted.
- **Wiring `backend/` into the root `mise.toml` and `infra/compose.yml`.** Deferred by the ground
  rules above; a small, separate, explicitly-approved step once phase 0 exists to wire into.
