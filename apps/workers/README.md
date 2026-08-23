# @keco/workers — the write side

Four independent Node processes that turn public GitHub data into a search index. **They never
talk to each other.** Each is a loop: read events from its own checkpoint → do work → write the
cache → append events → advance the checkpoint.

There is no queue server, no broker, no lock manager and no database. The filesystem is the job
state.

> [!NOTE]
> These processes are the **write side**. None of them may ever read a read model — an analyzer
> that queries Meilisearch to decide what to work on has broken the pattern, and the coupling
> is very hard to unwind later. See [AGENTS.md](../../AGENTS.md) §2, §3 and §4.

## The pipeline

```
 discovery ──▶ crawler ──▶  CACHE  ──▶ analyzer ──▶  CACHE  ──▶ projector ──▶ Meilisearch
 (enumerate)   (fetch)      (raw)      (classify)   (analysis)   (build)

                    └────────── journal of events ──────────┘
                       each consumer keeps its own checkpoint
```

| Worker | Consumes | Produces | Network | Status |
|---|---|---|---|---|
| **discovery** | keyword queries, search windows | `discovery/{query}/**` | GitHub **Search** (own pacer) | ✅ implemented |
| **crawler** | seed lists, `repos-full-list.yaml` | `repos/**`, `RepoFetched` | GitHub core REST + GraphQL | ⬜ scaffolded |
| **analyzer** | `RepoFetched` where `changed`, or an expired signal TTL | `analysis/**`, `RepoAnalyzed` | signal providers + LLM, **all cached** | ⬜ scaffolded |
| **projector** | `RepoAnalyzed` | Meilisearch `tools`, `repos_state` | none | ⬜ scaffolded |

`replay` is the fifth entrypoint and not a worker: it resets one consumer's checkpoint.

> [!IMPORTANT]
> The scaffolded three run, log their checkpoint, walk the journal and exit. Each carries a
> `TODO` naming exactly what it must do, in order. They are contracts with logging, not
> placeholders to rewrite — see [ROADMAP.md](../../ROADMAP.md) v1 → Write side.

### The cache is the write model

A directory (`CACHE_DIR`, default `.cache`) behind the `Storage` port in `@keco/cache`. Keys
only — no index, no queries.

```
discovery/{query}/_state.json          # resume position for this keyword's sweep
discovery/{query}/_hashes.json         # per-repo content hashes → the change delta
discovery/{query}/repos-full-list.yaml # what the sweep found; the crawler reads this directly
repos/{owner}/{repo}/…                 # repo.json, readme.md, tree.json, releases.json, manifests/
external/{provider}/{key}.json         # every third-party response + fetched_at/ttl/status
analysis/{owner}/{repo}.json           # analyzer output, schema-validated
journal/{YYYY-MM-DD}/{ulid}.json       # append-only events
checkpoints/{consumer}.json            # { last_event_id, updated_at }
```

Everything fetched is written **verbatim** — parsing happens downstream, so a parser bug is
fixed by re-analyzing, not re-crawling. Writes are atomic (temp key, then rename), which is the
entire recovery story: a half-written file is indistinguishable from a complete one on the next
run, because there is no next run that sees one.

`content_hash` (repo core fields + readme + tree) gates everything downstream. Unchanged hash
and unexpired signals ⇒ no analysis, no LLM call, no re-projection. It is the single most
important cost control in the system.

### Why discovery emits no events

Discovery publishes files and the crawler reads them. A weekly sweep would otherwise write
~100k tiny journal entries for no consumer's benefit, and a YAML artifact is directly
inspectable. This is a deliberate, documented exception to the event-flow contract — the delta
is already in `_hashes.json`, so emitting `RepoDiscovered` later is a small additive change.

## Development

Every entrypoint is a mise task. Arguments go after `--`.

```bash
mise run discovery -- --query kubernetes            # resumes from _state.json by default
mise run discovery -- --query kubernetes --fresh    # start this keyword's sweep over
mise run discovery -- --query kubernetes --limit 500

mise run crawler   -- --seed cncf,krew --limit 200
mise run analyzer
mise run analyzer  -- --force-refresh scorecard     # the only TTL bypass, and it is manual
mise run projector
mise run rebuild                                    # projector --rebuild: full offline replay + alias swap

mise run replay    -- --consumer analyzer           # reset a checkpoint
mise run pipeline                                   # crawl 200 seeded repos → analyze → project
```

> [!TIP]
> `--limit` stops at the first *window boundary* past N, so it overshoots. It is a dev-run
> convenience, not a budget.

Prerequisites: `mise run setup` once, `GITHUB_TOKEN` in `.env`, and Meilisearch running for the
projector (`mise run infra:up`).

### Replay is normal operation

```bash
mise run replay -- --consumer analyzer
mise run analyzer && mise run rebuild
```

Because every external call — GitHub, Scorecard, deps.dev, OSV, registries — landed in the
cache with a TTL, re-classifying the whole corpus after a rule, prompt or taxonomy change costs
almost nothing and touches nobody's rate limit. **Keep that property.** It is what makes the
pipeline cheap to iterate on.

Wiping the write model is `rm -rf .cache`; it is rebuilt by a crawl.

### Test, check, lint

```bash
pnpm vitest run apps/workers     # this app's suites (6 files, 68 tests)
pnpm -F @keco/workers check      # tsc --noEmit
mise run ci                      # what must be green before you call it done
```

Every `src/*/index.ts` executes `main()` on import, so **nothing declared in an entrypoint can
be unit-tested**. That is why discovery is thin by construction: the window algebra is
`windows.ts`, the split-vs-paginate decision is `plan.ts`, the resume-vs-new-sweep decision is
`sweep.ts`, persistence is `store.ts`, signal handling is `lib/shutdown.ts`. Every one of those
modules exists because a bug was found in it. Anything that carries a decision belongs in one
of them, not in `index.ts`.

New classification rules are tested against `packages/analyze/fixtures/*.json` — real cached
payloads, committed. **A new rule requires a fixture proving it**, and `pinning.test.ts`
asserts every value a rule can emit exists in `taxonomy.yaml`.

### Environment

Validated with zod at boot (`src/lib/config.ts`).

| Variable | Default | Used for |
|---|---|---|
| `GITHUB_TOKEN` | `''` | Classic PAT, `public_repo` scope |
| `GITHUB_QUOTA_CRAWLER_SHARE` | `0.8` | How the 5000 points/hour splits between crawler and analyzer |
| `CACHE_DIR` | `.cache` | The write model. A relative path resolves against the **workspace root**, not the process cwd, so every worker and `apps/api` share one cache |
| `MEILI_HOST` / `MEILI_MASTER_KEY` | `localhost:7700` | Projector only |
| `SHARD_COUNT` / `SHARD_INDEX` | `1` / `0` | Deterministic sharding — `hash(repo) % SHARD_COUNT == SHARD_INDEX` |
| `ANTHROPIC_API_KEY` / `ANALYZER_MODEL` | — / `claude-haiku-4-5-20251001` | Analyzer pass 3, deliberately a cheap model |
| `LOG_LEVEL` | `info` | pino |

## Rules this app is held to

- **Never read a read model.** The journal and checkpoints exist for this. Enforced by lint:
  only the projector may import `@keco/search`.
- **Never LIST the cache to find work.** A directory scan is merely slow today; the same code
  against object storage is slow *and* billed per request. Read the journal.
- **Never assume the cache is a filesystem.** No `fs.readFile` on a cache path, no globs, no
  `path.join` outside `@keco/cache`. Everything goes through the `Storage` port, so the S3
  adapter is a one-file change with no caller touched.
- **Never call a third party without the cache in front of it.** `@keco/signals` may only be
  imported by the analyzer, and every adapter in it goes through `@keco/cache` (lint-enforced).
  An uncached provider turns a replay into a 30k-request storm.
- **Degrade, never fail.** A provider that times out or 404s produces `signals.{provider} =
  null` plus an entry in `partial_signals[]`. Write the analysis anyway. A dead third party must
  never stall the pipeline.
- **Missing ≠ bad.** Most repos have no OpenSSF Scorecard, because OpenSSF never scanned them.
  Absence renormalises the quality axis; it never scores as zero. Treating it as zero is a
  silent, corpus-wide bias toward the famous.
- **Re-analyze on `content_hash` change *or* an expired signal TTL.** A repo unchanged for a
  year still needs its Scorecard refreshed weekly.
- **A single bad repo never aborts a run.** Catch per item (`perItem` in `lib/runtime.ts`), emit
  `RepoFailed`, continue.
- **Every worker is safe to kill at any moment.** Crash mid-batch ⇒ checkpoint not advanced ⇒
  reprocess ⇒ same result. Use `lib/shutdown.ts` rather than adding another
  `process.on('SIGINT')` — it already handles the SIGINT-then-SIGTERM echo a terminal Ctrl-C
  delivers to the whole `mise → pnpm → tsx → node` process group.
- **Scale out by sharding, not by locks.** There is no coordination primitive here and you must
  not invent one.
- **The projector stays pure** — cache in, index out, no network beyond Meilisearch — and is
  the **only** writer to Meilisearch. Advance its checkpoint only after `waitForTask`, or a
  crash loses a batch silently.
