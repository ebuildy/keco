# ADR 0004 — Remove registry seeds from the crawler; GitHub Search is the only discovery path

**Date:** 2026-09-07
**Status:** accepted
**Related:** ADR 0001 (CQRS, no database), AGENTS.md §4.1 (discovery), §4.2 (crawler)

## Context

AGENTS.md §4.2 originally had the crawler seed itself from registries before touching the
discovery corpus: the CNCF landscape, the krew index, Artifact Hub (Helm charts and, via its OLM
package kind, OperatorHub), and curated `awesome-*` lists. The reasoning was that a registry
entry is higher signal than a keyword match — something a foundation or package index put there
deliberately.

That reasoning conflated two different claims. A CNCF landscape entry, a krew plugin, a Helm
chart on Artifact Hub — every one of them **is a GitHub repo**, and every one of them is
already reachable by `discovery sweep`'s GitHub Search. Treating the registry as a second way to
*add* a repo to the corpus means the corpus can now disagree with itself about where a repo came
from, and it means the crawler — whose job is "fetch what discovery found" (§4.2) — was quietly
also deciding what belongs in the corpus, a decision that lives in discovery.

What a registry listing is actually good for is different: it's evidence about a repo already in
the corpus. CNCF's landscape carries a maturity level (graduated/incubating/sandbox) that
`classifyDerived` needs for `maturity` and `governance` (§6) — that's an enrichment fact about
`argoproj/argo-cd`, not a reason to independently discover `argoproj/argo-cd`.

## Decision

Remove the seed mechanism entirely: `crawler/seeds/{cncf,krew,artifacthub,awesome}.ts`, the
`SeedAdapter` registry (`crawler/seeds/index.ts`), the shared TTL-cache helper that only they
used (`crawler/external.ts`), and the `--seed` CLI flag. `discovery_repos` (GitHub Search,
via `discovery sweep`) becomes the crawler's only worklist source, alongside the existing
`--repo <owner/name|org>` explicit bypass.

`crawler/seeds/github/` — the per-repo fetch pipeline (README, tree, releases, icon) — is
unaffected (renamed to `crawler/sources/github/` on 2026-09-08, once it was the only thing left
under `seeds/` and the name no longer fit). It was never a `SeedAdapter`; it answers "what is in
one repo I already decided to
crawl," not "which repos exist."

## Consequences

- One trust source for corpus membership: a repo is in Keco because GitHub Search found it,
  full stop. No two-source reconciliation, no "seeded but never discovered" edge case.
- `mise run repo:crawl` (and `mise run pipeline`) with no discovery corpus yet now crawls
  nothing, where it previously crawled at least CNCF's and krew's listings on a cold start.
  Running `discovery sweep` first is now load-bearing, not optional — the two mise tasks and the
  design docs referencing `--seed` are all updated to reflect this.
- `crawl_history` documents drop `seeds` and `seed_errors` — a run's configuration is now fully
  described by `limit`, `repo`, and the shard config.
- The registry data itself is not thrown away as a concept: CNCF landscape, krew, Artifact Hub
  and OperatorHub membership are real signals about repos already in the corpus. Re-adding them
  belongs in the analyzer's pass 2 (§4.3, external signals) as new `packages/signals` providers —
  cache-first, TTL'd, degrade-never-fail, exactly like Scorecard and deps.dev — not back in the
  crawler as a discovery path. That work is not scoped yet; tracked in ROADMAP.md.

Revisit if GitHub Search itself proves an unreliable way to find a whole category of ecosystem
tool (e.g., something that structurally never surfaces for a keyword search), which would be a
real gap in the *discovery* worker, not a reason to reintroduce a second path in the crawler.
