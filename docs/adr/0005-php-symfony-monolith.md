# ADR 0005 — Rewrite the write side and API in PHP 8 / Symfony 8, as a monolith

**Date:** 2026-09-12
**Status:** accepted
**Supersedes:** ADR 0001 (CQRS, no database) — the "no database" half only
**Amends:** ADR 0002 (discovery's `DataStore` port) — the port is retired, not replaced
**Related:** ADR 0003 (crawler REST not GraphQL), ADR 0004 (remove crawler seeds) — both survive
unchanged; they were decisions about GitHub's API, not about the runtime

## Context

The write side (`packages/*`, `apps/workers`) and the read side (`apps/api`) are TypeScript/Node,
chosen when the team was optimizing for a fast, zero-infrastructure scaffold. That scaffold is
built and proven (`ROADMAP.md` v0–v1): the CQRS split, the taxonomy, the analyzer's three passes,
the crawler, and most of the projector exist and work.

The team is now standardizing on PHP 8 / Symfony for this codebase. This ADR is about *where the
runtime moves to*, not about *whether CQRS was right* — §2's split (write side never reads a read
model, read side never writes, read models are disposable) is kept in full. What changes is the
write model's storage and the process model workers run under, because both were shaped by
"no framework, no database" and that constraint is gone.

## Decision

1. **PHP 8.3+ / Symfony 8, as one application** (`backend/`) replaces `apps/api`, `apps/workers`,
   and every `packages/*` write-side package. It is a monolith in the sense §10 always meant for
   the backoffice: one deployable, one codebase, no service-to-service network calls — not in the
   sense of collapsing CQRS. The write side and the read side remain two halves of the same
   contract, now expressed as PHP namespaces instead of pnpm workspace packages.

2. **PostgreSQL, via Doctrine ORM, becomes the write model**, replacing the filesystem cache for
   everything structured: repo metadata, analysis output, the journal, checkpoints, discovery's
   corpus and run history, and chat traces. This directly reverses ADR 0001's "no database"
   clause. See "Why Postgres now" below for why the original rejection no longer holds.

3. **A blob store (Flysystem, local adapter today) survives** for exactly the payloads that are
   not relational: README markdown, icon bytes and their derived PNGs, and any oversized text.
   This is the direct descendant of `Storage` — same "one port, swappable adapter, verbatim bytes"
   discipline, narrowed to what actually needs it now that structured data has a real store.

4. **Symfony Messenger replaces the journal-as-coordination-mechanism and `p-queue`/`p-retry`.**
   Each pipeline stage (discovery, crawler, analyzer, projector) is a message + handler; transports
   are Doctrine-backed by default (no new infrastructure — Postgres is already there). The journal
   itself does not disappear: it becomes a `journal_events` table, because replay must stay
   durable and readable by every consumer independent of whatever is or isn't currently queued.
   Messenger dispatches *work*; the journal table remains the *record of what happened*, exactly
   as before (§2's rule 7: "events are facts about the past — never edit or delete one").

5. **Discovery's `DataStore` port (ADR 0002) is retired, not migrated.** It existed to keep a
   worker from naming a backend when the only two candidates were "filesystem" and "an unrelated
   Meilisearch instance being asked to hold non-search data" — a genuine mismatch worth hiding
   behind a port. With Postgres as the one write-model store for every worker, that mismatch is
   gone: `discovery_repos`, `discovery_runs`, `discovery_state` and `crawl_history` become
   ordinary Doctrine entities, queried the way every other write-model table is queried. Doctrine
   itself is the abstraction a future backend swap would go through; a second, hand-rolled port
   over it would be redundant.

6. **EasyAdminBundle builds the backoffice**, server-rendered inside the same Symfony app at
   `/admin` — no separate SPA build, no separate deployable. §10's rule ("no edit form, ever")
   maps onto EasyAdmin cleanly: every CRUD controller is registered read-only, and the only
   mutating actions are custom EasyAdmin actions that dispatch a Messenger command message,
   exactly like `/api/commands/*`.

7. **`apps/web`, the portal, is explicitly kept as a separate JavaScript SPA** (Vite/React,
   unchanged in spirit) that queries Meilisearch directly from the browser and calls the new PHP
   backend for README/icon/chat. It does not become a Symfony/Twig app. This is a deliberate
   scope boundary of this migration, not an oversight — see "What does not move" below.

## Why Postgres now, when ADR 0001 rejected it

ADR 0001 rejected Postgres because "it would buy queries we do not need and a migration burden we
do not want" in a hand-rolled Node scaffold with no framework. Both premises change under Symfony:

- **The migration burden is Symfony's core competency**, not an added cost: Doctrine migrations,
  the schema-diff tooling, and the whole ecosystem (`doctrine-architect`, `doctrine-migrations`
  skills) exist precisely for this. Paying for it via a filesystem-of-JSON-files was the actual
  detour, tolerable only because there was no framework to do it properly.
- **The queries were always needed and were being faked.** ADR 0002 already conceded this for
  discovery ("the corpus was not queryable... 100k YAML files... readable by key and nothing
  else") and routed around it by borrowing Meilisearch as a document store it was never meant to
  be. `repos_state` (§5) was the same problem for the backoffice: a *second* Meilisearch
  collection whose only reason to exist was "there is no database to ask instead." Postgres
  removes both workarounds at once.
- **`content_hash`-gated writes, ETag-conditional fetches and the journal's replay guarantee do
  not depend on the storage being a filesystem.** They depend on atomic writes and an ordered,
  durable event log — Postgres transactions and an indexed `journal_events(id)` give both, with
  range queries replacing directory scans (a strictly stronger version of "never LIST to find
  work", not a weaker one).

## What does not move

- **The taxonomy stays a single YAML file** (`taxonomy/taxonomy.yaml`, moved out of
  `packages/core` to a location both the PHP backend and the JS portal load directly). §6's rule
  — closed vocabulary, declared in data, never in code — is language-agnostic and is kept exactly.
- **The scoring formulas, the taxonomy families, the install-method verification rule, the
  README-sanitization requirement, the SEO/prerender contract, and the auth model (§12's single
  admin credential, not full auth)** are business rules independent of runtime. They are restated,
  not redesigned, in the rewritten `AGENTS.md`.
- **GitHub's API shape and the crawler's REST-not-GraphQL decision (ADR 0003)** are unaffected;
  a `SymfonyHttpClient`-based adapter replaces the Node GitHub client but honors the same
  conditional-request and rate-limit rules.

## Consequences

- **`packages/*` is deleted once the PHP equivalents land**, not kept alongside as a second
  implementation. There is exactly one write side at any point past the migration, per package —
  the transition itself will run both briefly (see the follow-up plan), but the destination has
  no permanent dual-maintenance.
- **The shared-code trick `@keco/core` relied on — one TypeScript module imported by both the
  Node backend and the browser bundle — stops being possible.** The portal and the backend are now
  different languages. Anywhere that mattered for correctness (URL params → Meilisearch filter
  string, the sort-key vocabulary, `defaultFacets`) must be duplicated in JS and PHP and kept in
  sync by a shared, language-agnostic fixture file, checked in both test suites. This is a real,
  ongoing cost of the split and is recorded as a "things that will bite you" entry in `AGENTS.md`
  rather than papered over.
- **Deterministic sharding (`hash(repo) % SHARD_COUNT`) is retired.** Messenger's Doctrine
  transport dequeues with row-level locking, so multiple consumer processes on the same transport
  already coordinate safely; a hand-rolled hash-based partition would be solving a problem
  Messenger's transport already solves.
- **`mise` stays the task runner** (it manages PHP/Composer today, not only Node), retargeted to
  call `composer` and `bin/console` instead of `pnpm` scripts.
- **Infra grows one dependency it didn't have**: PostgreSQL, alongside Meilisearch. This is
  accepted knowingly, the same way ADR 0002 knowingly accepted that `infra:reset` stopped being
  free.

## Alternatives rejected

- **Keep the filesystem cache as the write model, put a thin Symfony layer only in front of the
  API.** Rejected: it keeps ADR 0002's Meilisearch-as-document-store workaround alive forever and
  gets none of Doctrine's benefit for the one part of the system (structured write-model data)
  that most wanted a real store.
- **Rebuild the portal in Twig/Symfony UX too, for a single-language monolith.** Rejected for this
  migration: the portal's browser-direct-Meilisearch search-as-you-type experience (§9, ~80ms
  debounce, no backend round trip per keystroke) has no analogous "instant" story in a
  server-rendered Twig/Turbo model without reintroducing a query round-trip per keystroke, and the
  portal is working, tested (Playwright e2e) TypeScript that does not need to be rewritten to
  benefit from this migration. Re-litigate only if a concrete problem with keeping it JS shows up.
- **RabbitMQ/Redis for Messenger transports.** Rejected as a default: Postgres is already the
  write model, so the Doctrine transport adds no new infrastructure. A high-throughput transport
  can replace it later behind the same `MESSENGER_TRANSPORT_DSN` config, unchanged callers.
