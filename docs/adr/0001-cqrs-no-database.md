# ADR 0001 — CQRS with no database

**Status:** accepted · **Date:** 2026-08-01

## Context

Everything Keco shows is derived from public GitHub data. Nothing is curated, nothing is edited by
hand, nothing is precious. The expensive resources are the GitHub rate limit (5000 points/hour,
shared) and LLM calls — not storage and not CPU.

## Decision

Split commands from queries with no database on either side.

- **Write model** — object storage holding raw GitHub JSON, README markdown and every third-party
  response, verbatim and TTL'd. Keys only: no index, no queries.
- **Journal** — an append-only, ULID-keyed event stream. Each consumer keeps its own checkpoint.
  This replaces a queue server, locks and leases; workers shard deterministically instead.
- **Read models** — Meilisearch indexes, disposable and rebuildable offline from the cache with
  zero GitHub calls, promoted by alias swap.

## Consequences

- Replay is normal operation. A rule, prompt or taxonomy change is re-run over the whole corpus for
  the cost of CPU, because every external call already sits in the cache.
- A parser bug is fixed by re-analyzing, never by re-crawling — which is why "verbatim" is
  non-negotiable on write.
- Eventual consistency is a visible contract: every document carries `indexed_at` and the UI shows
  freshness rather than pretending to be live.
- There is no place to put human curation, and that is deliberate: a misclassification is fixed in
  the analyzer's rules, where the fix improves every similar repo at once.
- The costs are real: no joins, no transactions, no historical metrics, and full-corpus operations
  are batch jobs. All of that was accepted knowingly.

## Alternatives rejected

- **Postgres as the write model.** It would buy queries we do not need and a migration burden we do
  not want; object storage keyed by repo is enough because the only access pattern is "give me this
  repo's payload".
- **Meilisearch as the source of truth.** It would make the read model precious and couple the write
  side to it — the exact coupling §2.1 exists to prevent.
