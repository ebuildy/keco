# ADR 0002 — Discovery's write model moves to a `DataStore` port

**Date:** 2026-09-05
**Status:** accepted
**Supersedes:** the storage half of `docs/superpowers/specs/2026-08-02-discovery-worker-design.md`
**Related:** ADR 0001 (CQRS, no database)

## Context

Discovery wrote four artifacts to the filesystem cache: `repos-full-list.yaml`, one detail YAML
per repo, `_hashes.json` and `_state.json`. Three problems followed.

**There was no history.** A sweep's summary was computed in `runDiscovery`, logged once, and
lost. Nothing could answer "how did last night's sweep go", "how many new repos did we find
this week", or "what did that cost in GitHub Search calls".

**The corpus was not queryable.** 100k YAML files in two-letter buckets, readable by key and
nothing else.

**The substrate was hardcoded.** `DiscoveryStore` reached `@keco/cache` directly, so where
discovery's data lived was not a decision anyone could revisit.

## Decision

Discovery's data moves behind a **`DataStore` port** (`apps/workers/src/lib/data-store.ts`):
documents, equality filters, sort, count. Three implementations satisfy one conformance suite —
in-memory, filesystem, and Meilisearch — and **only `apps/workers/src/cli/data-store.ts` knows
which one is in use.** Workers take the interface; the CLI composition root injects an
implementation. `eslint.config.mjs` enforces this.

Discovery's data becomes three collections: `discovery_repos` (the corpus, replacing the detail
YAMLs, the full list *and* the hash index at once, since `payload_hash` is now a field),
`discovery_runs` (one document per sweep process), and `discovery_state` (resume).

## Why this does not violate ADR 0001 or §2

§4 says "the projector is the only writer to Meilisearch" and §2.1 says "the write side never
reads a read model". **Both are about searchable read models** — `tools`, the public corpus the
portal and API query — not about the Meilisearch *process*. §5 already draws the other half of
the line: "`searchableAttributes: []` makes an index a plain key-value store … use it for
everything that isn't the search corpus."

So there are two usages of one deployed instance:

| Usage | Collections | Owner | Rebuildable offline |
|---|---|---|---|
| Searchable read model | `tools`, `repos_state`, `traces` | projector | yes, from cache, zero network |
| Key-value data store | `discovery_*` | discovery | **no** — only by re-sweeping GitHub |

§4's rule is restated as **only the projector writes searchable read models**, which remains
true. Discovery writes write-model data through a storage port, the way it already writes
`repos/**` through `Storage`. ADR 0001's "no database" holds: no relational store, no schema
migration, no join.

## Consequences

**`mise run infra:reset` stops being free.** It used to wipe a disposable read model
rebuildable offline in minutes. It now also destroys discovery's resume state and corpus, which
come back only by re-sweeping GitHub Search — hours of paced requests. The task grows a
preflight that prints what it will destroy, sourced from `kecoctl discovery count` so the
warning and the data cannot disagree. This is the real cost of this decision and it was
accepted knowingly.

**`.cache/discovery/` is orphaned, not migrated.** Nothing reads or writes it after this
change. It is left in place rather than migrated — the cache is disposable and the corpus is
re-sweepable — and deleted with `rm -rf .cache/discovery`. There is deliberately no runtime
warning about it: `runDiscovery` no longer holds a `Cache` handle to probe with, and adding one
back to print a message would reintroduce exactly the coupling this ADR removes.

**Three improvements fell out of the move.** `--fresh` now deletes rather than merely ignoring,
retiring the orphaned-detail-file limitation the old store documented. The corpus is one map
keyed by repo id instead of an id-keyed list plus a name-keyed hash index, so the desync after
a repo rename has no second key to drift from. And `record()` buffers while `flush()` writes in
batches, because one write per repo is free on a filesystem and a round-trip per repo against
anything else.

## What the port deliberately does not have

**No `search()`.** `CollectionSpec.searchable` tells an implementation that has full-text to
build an index over those fields, so a human or the backoffice can query `discovery_repos`
directly — but no worker can express a relevance query. Adding `search()` would put a search
engine's semantics back into every worker, which is the one change this port exists to prevent.

## Alternatives rejected

**Keep the filesystem and add a separate run log.** Answers the history question and nothing
else; leaves the corpus unqueryable and the substrate hardcoded.

**A discovery-specific port rather than a general one.** Would have let Meilisearch concepts —
tasks, index settings, filter strings — leak into the interface, since a narrow port tends to be
shaped by its one implementation. The generic port has no backend vocabulary in it at all, which
is what makes the lint rule checkable.

**Migrate the projector too.** Its job is *defined* as writing the searchable read model, and it
needs alias swaps, count-verified promotion and rebuild-index creation — none of which
`DataStore` models. Modelling them would drag those concepts into the port. Out of scope.

## What the conformance suite bought

Worth recording, because it is the reason this landed without backend divergence. Written before
any implementation existed, it caught, among others: a store that hardcoded `'id'` as the
primary key (fine until `discovery_runs` uses `run_id`); a `remove({})` that would have wiped a
collection on two backends while erroring on the third; a `put` that left partial writes on one
backend and not the others; and a test double using `structuredClone`, which preserved `Date`
and `NaN` where every real backend JSON-normalises them — meaning code that passed in tests
would have thrown in production.
