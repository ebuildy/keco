# @keco/workers — the write side

Four independent Node processes that turn public GitHub data into a search index. **They never
talk to each other.** Each is a loop: read events from its own checkpoint → do work → write the
cache → append events → advance the checkpoint.

There is no queue server, no broker, no lock manager and no database. The filesystem is the job
state.

Alongside them lives **[`engine`](#the-engine-cli)**, which is not a worker at all: a one-shot
operator CLI for the read model, run by hand rather than by a schedule.

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
`engine` is the sixth, and also not a worker — see [The `engine` CLI](#the-engine-cli).

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

mise run engine    -- --help                        # the read-model CLI: index create, seed
mise run engine:index                               # create `tools` with the real settings
mise run mock                                       # …and fill it with fixtures, for local search
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
pnpm vitest run apps/workers     # this app's suites (11 files, 139 tests)
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
| `MEILI_HOST` / `MEILI_MASTER_KEY` | `localhost:7700` | Projector and `engine`; both accept `--host` to override for one run |
| `SHARD_COUNT` / `SHARD_INDEX` | `1` / `0` | Deterministic sharding — `hash(repo) % SHARD_COUNT == SHARD_INDEX` |
| `ANTHROPIC_API_KEY` / `ANALYZER_MODEL` | — / `claude-haiku-4-5-20251001` | Analyzer pass 3, deliberately a cheap model |
| `LOG_LEVEL` | `info` | pino |

## The `engine` CLI

Not a worker: a one-shot command that runs to completion, consumes no journal and advances no
checkpoint. It is the tooling you run *around* the read model rather than inside the pipeline.
Built with [commander](https://github.com/tj/commander.js).

```
engine
├── index create      bootstrap an index with the real `tools` settings     (safe on production)
└── seed              fill an index with the mock corpus                    (local only)
```

```bash
mise run engine -- --help              # every command
mise run engine -- seed --help         # one command's flags
```

The two commands have deliberately different blast radii, and each owns its own guard rather
than sharing one: creating an index is how a fresh deployment starts, while seeding pushes
fabricated `install_methods` and must never reach a real corpus (§6).

Both take the same two flags:

| Flag | Default | What it does |
|---|---|---|
| `-H, --host <url>` | `$MEILI_HOST`, else `http://localhost:7700` | Which Meilisearch to talk to |
| `-i, --index <uid>` | `tools` | Which index to act on |

They are attached to each command rather than to the root, so `engine index create --index x`
works and reads the right way round.

### `engine index create`

Creates the index if it is missing and applies the real `tools` settings from `@keco/search` —
the searchable, filterable and sortable attributes plus the ranking rules. An index without
them is not worth searching: no facets, no `score.total` tie-break, no typo tolerance.

**This is the one command here that is safe to run against production.** It is how a new
deployment's index is bootstrapped, and it is idempotent. What it will *not* do is re-apply
settings to an index that already holds documents, because a settings change reindexes the
whole corpus and §5 forbids that on the live alias.

| Index state | What happens |
|---|---|
| Missing | Created, settings applied |
| Exists, empty | Settings applied — nothing to reindex |
| Exists, populated | **Settings not applied.** Warns, exits `0` |
| Exists, populated, `--force-settings` | Settings applied — reindexes every document |

```bash
mise run engine:index                                       # bootstrap `tools` locally
mise run engine -- index create --host https://search.internal --index tools_20260826
mise run engine -- index create --force-settings            # only on a disposable index
```

The populated case exits `0` rather than failing, so a bootstrap step in a deploy script stays
idempotent; it logs at `warn` so the decision is visible in a deploy log.

> [!IMPORTANT]
> To change settings on a corpus that is already serving, `--force-settings` is the wrong tool.
> Build a new index, apply settings to it, verify the document count, then swap the alias
> (§4.4) — that is the path with a rollback.

### `engine seed`

Reads [`infra/mock/corpus.json`](../../infra/mock/README.md) — 300 fabricated documents shared
with the portal's mock backend — validates every one, and upserts them in batches, awaiting
each Meilisearch task before starting the next.

It exists because the projector is still scaffolded. Until it lands, nothing fills `tools`, and
the search engine cannot be exercised at all without something in it.

| Flag | Default | What it does |
|---|---|---|
| `-b, --batch <n>` | `500` | Documents per batch |
| `--clear` | off | Delete every existing document first |
| `--force` | off | Allow a non-local `--host` |

```bash
mise run mock                          # index create + seed --clear, from nothing
mise run engine:seed -- --clear        # reseed after editing the fixtures
mise run engine -- seed --batch 50     # smaller batches, to watch the task queue
```

`mise run engine:seed` depends on `mock:corpus`, so the JSON is re-emitted from
`apps/web/src/mocks/corpus` before every seed and cannot go stale.

#### Three guards, and why

The corpus carries invented stars, scores and — the one that matters — invented
`install_methods`. §6 calls a `brew install` line for a formula that does not exist the worst
bug this project can ship. So:

1. **Every document must carry the mock sentinel** (`KECO_MOCK_CORPUS_DO_NOT_SHIP`) in
   `discovery_source`. The command refuses a corpus where one does not, so it cannot be
   repurposed to push real documents — and anything it wrote can be found by filtering on it.
2. **Every document is parsed through `ToolDocument`.** The taxonomy is data (§6), so
   `governance: 'vendor_backed'` is not a type error; Meilisearch would accept it happily and
   no chip would ever match. Validation is the only thing that catches it.
3. **A non-local `--host` is refused** unless you type `--force`.

It also refuses an index that does not exist rather than creating an unconfigured one — run
`engine index create` first.

### Output and exit codes

Structured pino JSON on stdout, like the workers. `0` on success, including the
populated-index case above, which is a decision rather than a failure. `1` on any error, with
the message on the `err` field. Commander handles `--help`, unknown flags and invalid argument
values itself, so `--batch 0` is a usage error rather than an exception.

### A local search sandbox from nothing

```bash
mise run infra:up      # Meilisearch on :7700
mise run mock          # engine index create + engine seed --clear
mise run web           # the portal, now searching a real engine
```

### Where the logic lives

`index.ts` entrypoints cannot be unit-tested (see above), and the same rule shaped this CLI:
`cli.ts` is argument wiring only. `planIndexCreate` in `create-index.ts` decides what to do to
an index from its observed state, `seed.ts` holds the batching loop and the local-host guard
with no Meilisearch client in sight, and `corpus.ts` owns loading and validation. All three are
unit-tested; `cli.ts` is not, because there is nothing in it to test.

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
  crash loses a batch silently. `engine seed` is the one documented exception (§4), and it
  earns it: no journal, no checkpoint, sentinel-stamped fixtures only, and it refuses a
  non-local host. It is not precedent for a second writer that does none of those things.
