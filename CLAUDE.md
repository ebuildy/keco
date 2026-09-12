# AGENTS.md — Keco

Instructions for AI coding agents working in this repository. Read this fully before touching
code.

## 0. Where the code is vs. where this document points

Keco is mid-migration from a TypeScript/Node scaffold to a **PHP 8 / Symfony 8 monolith**
(`docs/adr/0005-php-symfony-monolith.md`, `docs/superpowers/specs/2026-09-12-php-symfony-migration-design.md`).
This document describes the **destination architecture** — what `backend/` is being built to be —
not necessarily what exists in the tree at any given commit. Check `ROADMAP.md` for what's
actually landed before assuming a section below is implemented.

What's true right now:

- **`apps/web`** (the public portal) is unaffected by the migration and works today: Vite +
  React, static SPA, build-time prerender, Playwright e2e. It stays TypeScript — see §9 and ADR
  0005's "What does not move".
- **`backend/`** (the Symfony monolith) is the target for everything that used to be `apps/api`,
  `apps/workers`, and every `packages/*` write-side package. It is being built out one bounded
  context at a time, per plans under `docs/superpowers/plans/`. Until a context lands, its old
  TypeScript implementation (`apps/workers/src/<context>`, `packages/<context>`) is still the
  source of truth for that piece — **do not delete a TS implementation until its PHP replacement
  has parity and its own plan says so.**
- **`packages/*` and `apps/workers` are deleted once `backend/` reaches full parity** — not kept
  permanently alongside it. A PR that adds to `packages/*` or `apps/workers` for anything beyond
  finishing an in-flight migration step is almost certainly a mistake this late in the migration.
- `/admin` will be `apps/backend`'s EasyAdminBundle dashboard, mounted inside the same Symfony
  app — no separate SPA build, unlike the abandoned `apps/backoffice` plan this document used to
  describe. See §10.
- `/api/mcp` and `/api/chat` remain declared and largely unimplemented regardless of runtime —
  tracked in `ROADMAP.md`, not blocked by the migration.

## 1. What Keco is

Keco is a search portal for the **Kubernetes ecosystem**. Everything it shows is derived from
public GitHub data: workers pull repositories into a write model, analyzers classify and score
them from that write model, and the result is projected into Meilisearch, which the portal, the
API and the MCP endpoint read.

**The product is the data quality.** A beautiful UI over a badly classified corpus is
worthless. When in doubt, invest in the analyzers, not the frontend.

Non-goals — do not build these:

- Human curation, overrides, moderation queues, editorial content. Postgres holding the write
  model does **not** reopen this — see §10, "no edit form, ever."
- Historical metrics, time series, star history.
- End-user accounts, comments, votes. The portal is anonymous and read-only.
- Hosting packages or proxying downloads.
- Heavy infrastructure beyond what's already decided: Postgres and Meilisearch, no more. No
  Redis, no RabbitMQ, no Kubernetes-for-Kubernetes. Symfony Messenger's Doctrine transport is the
  default precisely to avoid adding a broker (§4). If a problem looks like it needs one at this
  scale, it usually needs a smaller loop instead.

Everything is reproducible from GitHub. Nothing in this system is precious — not even the
database now that one exists: `Repo` and `Analysis` rows are rebuilt by re-crawling and
re-analyzing, and the `tools` index is rebuilt by re-projecting. Postgres is durable, not sacred.

### Developer workflow

Tools and runtimes are installed by **mise** (`mise.toml` pins PHP, Composer, and Node — Node
stays for `apps/web`). Every dev script is a mise task; nothing is invoked ad-hoc. `mise tasks`
lists them; §8 explains them.

The roadmap — what is done, what is next, and what is deliberately not planned — is
[ROADMAP.md](./ROADMAP.md). Check it before proposing work.

## 2. CQRS — the organising principle

**Read this before writing any code. Every design question is answered by it.**

```
        ┌──────────────────────── WRITE SIDE (commands) ──────────────────────────┐
        │                                                                         │
 GitHub │ discovery ─▶ crawler ─▶ POSTGRES ─▶ analyzer ─▶ POSTGRES ─▶ projector    │
  API   │ (enumerate)  (fetch)   (Repo rows) (classify)  (Analysis)   (build)      │
        │                    └────── journal_events table + Messenger ──────┘      │
        └───────────────────────────────────┬─────────────────────────────────────┘
                                            │ project
        ┌───────────────────────────────────▼─────────────────────────────────────┐
        │  READ MODEL — Meilisearch                                               │
        │  `tools` (public search index) — the only searchable read model now     │
        └───────────────────────────────────┬─────────────────────────────────────┘
                                            │ query only
                    apps/web  ·  backend/ (Api: REST · MCP · chat, Backoffice: /admin)
```

One Symfony application (`backend/`) hosts both halves of this diagram as separate namespaces —
"monolith" means one deployable and one codebase, not that the CQRS split collapses. The rules,
in priority order, are unchanged from the original TypeScript design:

1. **The write side never reads a read model.** A `MessageHandler` under `Discovery`, `Crawler`,
   `Analyzer` or `Projector` that queries `Search`/`Query` (Meilisearch) to decide what to work on
   has broken the pattern — it uses the `journal_events` table and its own `Checkpoint` row
   instead. This is the mistake to watch for; it is subtle and it couples everything back
   together. Enforced by `deptrac.yaml` (§7), not just convention.
2. **The read side never writes.** No controller, MCP tool or chat handler mutates a Doctrine
   entity or a Meilisearch document. If a read path needs to write, the design is wrong. The one
   deliberate exception is named in §11 (command dispatch): it appends a `JournalEvent` or resets
   a `Checkpoint` — it never touches `Repo`, `Analysis` or the `tools` index directly.
3. **Read models are disposable.** `tools` is rebuildable from Postgres by replay, offline, in
   minutes, with zero GitHub calls. If a change can't be applied by re-projecting, it isn't done
   right.
4. **Postgres is the write model, plus a narrow blob store for what isn't relational.** Every
   structured payload — repo metadata (with the verbatim raw GitHub JSON preserved in a jsonb
   column), analysis output, the journal, checkpoints, discovery's corpus and run history, chat
   traces — is a Doctrine entity. README markdown and icon bytes stay in a blob store (§3.1)
   because they're large, unstructured, and never queried by field. Workers may call the network
   freely; they may never call it twice for the same thing (§4.3's cache-first rule for signals).
5. **Commands are asynchronous and idempotent.** Messenger message handlers never call each
   other's handlers directly, never block on each other, never share a transaction across
   transports. They communicate only through Postgres (the journal, the entities) and dispatched
   messages.
6. **The two models have different shapes.** The write model is verbose, close to GitHub's raw
   shape (`Repo.raw_payload` keeps it verbatim); the read model is a flat, denormalized document
   optimized for search. Never leak the raw shape into `tools`, never store search-shaped
   documents in the write model.
7. **Eventual consistency is the contract.** A repo crawled now appears in search minutes later.
   Every `tools` document carries `indexed_at`; the UI shows freshness rather than pretending
   it's live.

## 3. The write model (Postgres, via Doctrine)

Every structured write-side fact is a Doctrine entity in `backend/src/Entity`, migrated by
`backend/migrations` — there is no other schema history. See
`docs/superpowers/specs/2026-09-12-php-symfony-migration-design.md` §3 for the full entity list
and what each replaces. In brief:

| Entity | Holds |
|---|---|
| `Repo` | Typed columns for what's scored/filtered (`stars`, `forks`, `pushed_at`, `archived`, `license`, `content_hash`, `etag`, `fetched_at`) **plus** `raw_payload jsonb` — the verbatim GitHub API response — **plus** `tree jsonb` and `manifests jsonb` for pass-1 rule inputs. |
| `Analysis` | `kind`, `domains[]`, `runtime`, `license_class`, `openness`, `maturity`, `governance`, `confidence`, `method`, `model`, `signals jsonb`, `signals_used[]`, `partial_signals[]`, `content_hash`, `analyzed_at`. |
| `JournalEvent` | `id` (ULID, PK), `type`, `repo`, `payload jsonb`, `created_at` — append-only, indexed for ordered replay. |
| `Checkpoint` | `consumer_name` (PK), `last_event_id`, `updated_at` — one row per consumer. |
| `DiscoveryRepo` / `DiscoveryRun` / `DiscoveryState` | Discovery's corpus, sweep history, and resume position. |
| `CrawlHistoryEntry` | One row per crawl run: counts, cost, outcome. |
| `ExternalSignal` | Pass-2 provider cache: `provider`, `cache_key`, `payload jsonb`, `fetched_at`, `ttl_seconds`. |
| `ChatTrace` | `(query, retrieved_ids, answer, created_at)` for eval fixtures. |

Rules, all mandatory:

- **`raw_payload` means verbatim.** Never transform GitHub's response before storing it there.
  Parsing happens downstream (into the typed columns and into `Analysis`), so a parsing bug is
  fixed by re-deriving from `raw_payload`, never by re-crawling. This is the single rule that
  survived the migration completely unchanged from the filesystem-cache design, because it was
  never about the storage mechanism — it was always about not needing the network to fix a bug.
- **Writes are transactional**, not merely atomic-by-rename the way filesystem writes were. A
  half-committed `Repo` row cannot exist; use a real Doctrine transaction wherever a crawl step
  touches more than one entity.
- **`content_hash`** = hash(the fields of `raw_payload` that matter + README + tree). It is still
  the change signal for the entire pipeline. Unchanged hash ⇒ no analysis, no LLM call, no
  re-projection — the single most important cost control in the system, unchanged.
- **Never full-table-scan to find work.** `journal_events` is read by an indexed range query
  (`WHERE id > :checkpoint ORDER BY id LIMIT :n`), never by scanning `Repo`/`Analysis` to guess
  what changed. This is a *stronger* version of the old "never LIST the cache" rule, not a
  relaxation of it: a filesystem scan was merely slow, an unindexed Postgres scan is slow **and**
  it holds locks other workers need.
- **`ExternalSignal` is cache-first, always** (§4.3). A row inside its `ttl_seconds` never causes
  a network call. `--force-refresh` is the only bypass, and it's a manual per-provider flag on the
  analyzer console command.

### 3.1 The blob store — what still isn't a database row

A `BlobStorageInterface` (Flysystem; local adapter today, an S3-compatible adapter slots in
behind the same interface later — same "one port, swappable adapter" discipline the old `Storage`
port had) holds exactly:

```
repos/{owner}/{repo}/readme.md            # raw markdown, verbatim
repos/{owner}/{repo}/icon.src             # icon bytes, verbatim; content type lives on Repo
repos/{owner}/{repo}/icon-{32,64,160}.png # derived — re-derivable offline, never re-crawled
```

Everything that used to be a small JSON file on disk (`repo.json`, `tree.json`, `manifests/*`,
`external/*.json`) is now a jsonb column or a queryable table (§3 above) — resist putting
structured data back into the blob store out of habit. The blob store is narrow on purpose: it
holds what genuinely isn't relational, not everything that happens to be a file today.

### The journal

`JournalEvent` is an append-only Doctrine entity, ULID-keyed so it sorts the way the old
filename convention did, letting a consumer resume from an offset stored in its `Checkpoint` row:

```php
// backend/src/Journal/Event — one class per event type, all immutable
RepoDiscovered(repo: string, source: string)
RepoFetched(repo: string, contentHash: string, changed: bool)
RepoAnalyzed(repo: string, contentHash: string, confidence: float)
RepoSkipped(repo: string, reason: string)
RepoFailed(repo: string, phase: string, error: string)
```

Each consumer keeps its own `Checkpoint`. Replay is normal operation, not an incident: reset the
checkpoint row and everything downstream rebuilds by re-reading `journal_events`. Events are
facts about the past — **never `UPDATE` or `DELETE` a `JournalEvent` row.**

## 4. Workers (write side)

Four independent bounded contexts inside `backend/`: `Discovery`, `Crawler`, `Analyzer`,
`Projector`. **They never call each other's services directly.** Each is: a Messenger message +
handler that reads its inputs from Postgres → does work → writes Postgres/the blob store →
appends `JournalEvent`s → dispatches the next stage's message.

| Context | Triggered by | Produces | Network | Cadence |
|---|---|---|---|---|
| **Discovery** | `SweepDiscoveryQuery` (Scheduler/cron) | `DiscoveryRepo`, `DiscoveryRun`, `DiscoveryState` rows | GitHub Search (paced) | periodic sweep, resumable |
| **Crawler** | `CrawlRepo` (dispatched per `DiscoveryRepo`) | `Repo` rows, blob store, `RepoFetched` | GitHub (rate-limited) | continuous, full sweep weekly |
| **Analyzer** | `AnalyzeRepo` (dispatched on `RepoFetched{changed:true}` or an expired signal) | `Analysis` rows, `RepoAnalyzed` | signal providers + LLM, **all cached** | continuous |
| **Projector** | `ProjectRepo` (dispatched on `RepoAnalyzed`) | Meilisearch `tools` | none | continuous, batched |

**Each context is a Symfony Messenger transport**, backed by Doctrine by default (no new
infrastructure — Postgres already holds everything else). Concurrency is replica count: run
multiple `bin/console messenger:consume async_<context>` processes against the same transport;
the Doctrine transport's row-level locking means they split work safely with **no sharding
scheme** — the old `hash(repo) % SHARD_COUNT` existed only because a filesystem had no
coordination primitive, and Postgres does. Retry is Messenger's `retry_strategy`
(`config/packages/messenger.yaml`), configured per transport.

Consequences that matter:

- **A single bad repo must never retry-storm or block a transport.** A handler catches its own
  failures, appends `JournalEvent{type: RepoFailed}`, and returns success to Messenger rather than
  rethrowing — rethrowing would hand a permanently-broken repo to Messenger's retry policy and,
  eventually, its failure transport, which is not where per-repo failures belong. This is the
  direct descendant of "workers are safe to kill at any moment / crash mid-batch never corrupts
  state", re-expressed for a message queue instead of a crash-resumable loop.
- The analyzer **may** call the network — Scorecard, deps.dev, registries, GitHub for signals the
  crawler didn't collect. Every call goes through `ExternalSignal`'s cache-first repository, so a
  *replay* (rule changes, prompt changes, taxonomy changes re-run over the whole corpus) is
  nearly free. Keep that property; it's what makes the pipeline cheap to iterate on.
- The projector is pure: Postgres in, Meilisearch out, no network. It must stay that way — it is
  the thing you re-run most often.
- The projector is the only writer to Meilisearch's `tools` index. The one exception is
  `bin/console app:index:seed`, dev-only tooling that pushes `infra/mock/corpus.json` into a
  local index so the search engine can be exercised before the projector fills it. It refuses a
  non-local `MEILI_HOST` (§8).
- Scheduling is Symfony Scheduler (or system cron invoking `bin/console app:*:sweep`), not
  GitHub Actions — the write model lives in a real Postgres instance, not in git, so a
  long-running scheduled process is the right shape.

### 4.1 Discovery

Enumerates candidate repos; it does not fetch them. GitHub Search returns **at most 1000 results
per query**, so the unit of work is a *window*: a query narrowed by a `stars:` band and a
`created:` range small enough to stay under the cap. The window-splitting algebra, the
split-vs-paginate decision for a probed window, and the resume-vs-new-sweep transition are pure
PHP with no framework dependency, unit-testable without Postgres — the same shape the old
`windows.ts`/`plan.ts`/`sweep.ts` had, just as PHP classes under `Discovery/`.

**Discovery appends no `JournalEvent`s.** It writes `DiscoveryRepo` rows directly, and the
crawler reads that table as its worklist. This is a deliberate exception to §2's event-flow
contract: a weekly sweep would otherwise write ~100k tiny journal rows. The delta is already
computed from a `payload_hash` column, so emitting `RepoDiscovered` later is a small additive
change if the crawler ever needs a resumable offset instead of a full-table read.

**Every sweep records a run.** Opening a sweep inserts a `DiscoveryRun` row immediately with
`outcome: 'running'`; finishing it stamps the ending on every path out — complete, failed, and a
`SIGTERM`/kill signal handler's `interrupted`. A killed process therefore leaves a run at
`running` forever, deliberately: that stuck row is how an operator spots a sweep that died
without cleanup.

- **Resume by default.** A sweep continues from its `DiscoveryState` row; `--fresh` is the
  explicit opt-out, and deletes the query's `DiscoveryRepo` rows and `DiscoveryState` row rather
  than merely ignoring them. It never touches `DiscoveryRun`. `--limit` stops at the first window
  boundary past N — a dev-run convenience, not a budget.
- **Change-gated writes.** A window whose result set is byte-identical is not rewritten, so a
  re-sweep produces no churn.
- Discovery has its own rate pacer, built on Symfony's `RateLimiter` component — GitHub Search is
  limited far more tightly (~30 req/min authenticated) than the core REST API, and mixing the two
  budgets stalls both.

### 4.2 Crawler

Fetches everything discovery named, into `Repo` rows and the blob store. GitHub Search (via
`Discovery`) is the only trust source for *which* repos are in the corpus — `DiscoveryRepo` is
the crawler's sole worklist, plus the explicit `--repo <owner/name|org>` bypass. Registry lists
(CNCF landscape, krew index, Artifact Hub, OperatorHub, curated `awesome-*`) do **not** feed this
worklist directly — see `docs/adr/0004-remove-crawler-seeds.md`, unaffected by this migration:
every one of those entries is itself a GitHub repo GitHub Search already finds, so registry data
remains an analyzer signal (§4.3, feeding `maturity`/`governance`), never a discovery path.

- REST for everything, one conditional request per repo — not GraphQL. See
  `docs/adr/0003-crawler-rest-not-graphql.md`, unaffected by this migration: GraphQL still
  supports no conditional requests, and a 304 short-circuit is still three orders of magnitude
  cheaper in the weekly steady state.
- `ETag` / `If-None-Match` on everything, via `HttpClient`: a 304 costs no quota and
  short-circuits to `RepoFetched{changed: false}`.
- A 304 on `/repos` short-circuits the whole repo: no push since the last crawl means README,
  tree and releases cannot have changed. A `Repo.fetched_at` older than 30 days re-fetches
  anyway, so the assumption self-heals if it's ever wrong.
- Honour `x-ratelimit-remaining`, exponential backoff on 403/429, respect `retry-after`. A
  crawl that gets the token throttled is a failed crawl.
- Skip, decided from `raw_payload` alone so the decision costs no extra requests: forks (unless
  > 200 stars), archived + stale > 24 months (unless > 1000 stars). Append `JournalEvent{type:
  RepoSkipped}` with a reason — never drop silently.
- `ci-manifest-only` is the **analyzer's** job, not the crawler's: keep those repos in Postgres
  and filter them at projection time (§14), `k8s_relevance` is analyzer-assigned, and deciding it
  needs the README and tree the skip check runs before.

### 4.3 Analyzer — rules first, external signals, AI as fallback

Three passes over each repo, cheapest first. Local rules settle most of it; external providers
add what GitHub metadata can't tell you; the LLM only sees what's left ambiguous.

#### Pass 1 — local rules (Postgres only, free)

Deterministic signals settle most repos, free and reproducible, reading only `Repo.raw_payload`,
`Repo.tree` and `Repo.manifests`:

- `topics[]`; name patterns (`kubectl-*`, `*-operator`, `*-controller`)
- Tree: `Chart.yaml` → helm-chart · `config/crd/` + `PROJECT` → operator (kubebuilder) ·
  `.krew.yaml` → kubectl-plugin · `cmd/` + cobra → cli
- Manifests: `sigs.k8s.io/controller-runtime`, `k8s.io/client-go` (go.mod), `kube`
  (Cargo.toml), `@kubernetes/client-node` (package.json)
- README badges/headings → install *candidates*, to be verified in pass 2

Each rule is one PHP class under `Analyzer/Rules`, with a fixture in `backend/tests/Fixtures`
proving it — the same discipline `packages/analyze/fixtures` enforced, just relocated.

#### Pass 2 — external signals (`Analyzer/Signals`)

Things GitHub's repo API cannot tell you. Every provider is a small `HttpClient`-based adapter
with a **fixed TTL** and a **hard timeout**, and every response lands in an `ExternalSignal` row.

| Provider | Gives | TTL |
|---|---|---|
| **OpenSSF Scorecard** (`api.securityscorecards.dev`) | maintenance, code review, CI tests, signed releases, branch protection, dangerous workflows, known vulns | 7 d |
| **deps.dev** (`api.deps.dev/v3`) | project metadata, Scorecard mirror, dependency/dependent counts across ecosystems | 7 d |
| **OSV.dev** | known vulnerabilities affecting the project | 3 d |
| **Homebrew** (`formulae.brew.sh/api/formula.json`) | proof a formula exists + exact name | 1 d, one bulk file for the whole corpus |
| **krew index**, **Artifact Hub**, **OperatorHub** | proof of plugin/chart/operator publication | 1 d |
| **CNCF Landscape** (`cncf/landscape`'s `landscape.yml`) | `maturity`/`governance` seed | 7 d, one bulk fetch |
| **GitHub** (extra) | contributors, dependents, release cadence, community profile | 7 d, **shares the crawler's quota** |

Rules, all mandatory:

- **Cache first, always.** An `ExternalSignal` row inside its `ttl_seconds` never hits the
  network. `--force-refresh` is the only bypass, a manual per-provider console flag.
- **Bulk over per-repo** wherever the provider allows it. Fetching `formula.json` once per corpus
  run is right; fetching it per repo is 30k requests for the same file.
- **Degrade, never fail.** A provider that times out, 404s or rate-limits produces
  `signals.{provider} = null` plus an entry in `partial_signals[]`. Write the `Analysis` row
  anyway, append `RepoAnalyzed{partial: true}`, and let the next run fill the gap. A dead third
  party must never stall the pipeline or block indexing.
- **Missing ≠ bad.** Scorecard only covers projects in OpenSSF's weekly cron set, so most small
  repos have no score at all. Treat absence as *unknown* and renormalise the quality axis over
  the signals you actually have — never as a zero. Scoring a repo badly because a third party
  never looked at it is a silent, corpus-wide bias.
- **GitHub calls here share the crawler's 5000 points/hour**, split by
  `GITHUB_QUOTA_CRAWLER_SHARE` (default 0.8, a Symfony parameter). Two components spending the
  same quota without a contract is how crawls start failing at 3am.
- Record every provider's `fetched_at` on `ExternalSignal`. A score you can't date is a score
  you can't defend.

#### Pass 3 — LLM fallback

Only when confidence < 0.7 or `kind` is ambiguous: README first 8 KB + topics + tree + the
signals from pass 2, requiring **structured output validated against the taxonomy** before use
(a PHP DTO + Symfony Validator refinement against `taxonomy/taxonomy.yaml`, replacing zod's
`AnalysisSchema`). Invalid → retry once → fall back to `kind: 'service'`, `confidence: 0.3`,
`needs_review: true`. Free text never leaves the analyzer. The model is configured (parameter
`analyzer.model`), and it is a cheap one on purpose — pass 3 should be a minority of the corpus,
and if it isn't, the fix is a rule, not a bigger model.

Every `Analysis` row records `method` (`rules` | `signals` | `llm`), `model`, `content_hash`,
`signals_used[]` and `partial_signals[]` — so any classification can be explained, dated and
reproduced.

### 4.4 Projector

Reads `Repo` + `Analysis` rows, computes scores, builds the read model, upserts in batches of
≤1000, awaits the Meilisearch task, advances its `Checkpoint`.

```
popularity = log10(stars + 1) / log10(100000)
activity   = f(pushed_at recency, releases, commit recency, Scorecard::Maintained)
adoption   = presence in krew / brew / Artifact Hub / CNCF landscape + deps.dev dependents
quality    = license + releases + docs + !archived
             + Scorecard (Code-Review, CI-Tests, Signed-Releases, Branch-Protection)
             − OSV open vulnerabilities
total      = 0.35*popularity + 0.30*activity + 0.20*adoption + 0.15*quality
momentum   = stars / repo_age_days, z-scored across the corpus, damped by activity
```

The `quality` axis is **renormalised over available signals**: a repo with no Scorecard is
scored on the sub-signals it has, not penalised for the missing one. Store `quality_coverage`
(share of signals present) alongside the score and show it in the UI — a 0.9 from four signals
and a 0.9 from one are not the same claim.

Stars alone rank dead-but-famous repos above healthy new ones — that is the failure mode to
design against. `archived` caps `total` at 0.4.

**On "trending":** with no history, true star velocity is unavailable. `momentum` (stars per day
of age, damped by recent activity) is the honest substitute. Label it "momentum" in the UI, not
"trending this week". Do not fake a time series.

**Full rebuild** = build `tools_<ts>` from Postgres, apply settings, verify document count, swap
the alias, keep the previous index for one cycle for instant rollback. Never mutate the live
alias, never swap onto a half-built index. This is a `bin/console app:project --rebuild`
invocation, entirely offline once `Repo`/`Analysis` data exists — zero GitHub calls, same as
before.

## 5. Read model (Meilisearch)

**One Meilisearch instance, one job now.** ADR 0002's `discovery_*`-as-key-value-store workaround
and `repos_state`/`traces`'s Meilisearch collections both retired once Postgres existed to hold
that data properly (ADR 0005). What's left is exactly the search corpus:

| Index | Consumer | Searchable | Contents |
|---|---|---|---|
| `tools` (alias → `tools_<ts>`) | portal, REST, MCP, chat | yes | the public corpus, < 8 KB/doc |

The backoffice (§10) reads pipeline status from `Repo`/`Analysis`/`JournalEvent` directly via
Doctrine, and chat traces from `ChatTrace` — no second Meilisearch collection needed for either.

### `tools` settings

- `searchableAttributes` in weight order: `name`, `full_name`, `summary`, `description`,
  `github_topics`, `readme_excerpt`.
- `filterableAttributes`: `kind`, `domains`, `runtime`, `install_methods`, `language`, `license`,
  `license_class`, `openness`, `maturity`, `governance`, `archived`, `stars`, `has_release`,
  `k8s_relevance`, `has_scorecard`.
- `sortableAttributes`: `stars`, `score_total`, `score_momentum`, `pushed_at`.
- Default ranking rules + `score_total:desc` appended — relevance first, health as tie-breaker.
- `pagination.maxTotalHits` raised deliberately (default 1000 caps deep paging).
- Embedder configured here for hybrid search (v2).

### Document shape

Unchanged from the pre-migration design — this is the contract the portal and the API were
already built against:

```ts
{
  id, owner, name, full_name, description, homepage, repo_url,
  stars, forks, open_issues, language, license, github_topics[], archived,
  pushed_at, created_at, discovery_source,
  summary, kind, domains[], runtime, license_class, openness, maturity, governance,
  k8s_relevance, confidence, needs_review,
  install_methods: [{ method, command, source_url, verified_at }],
  score: { popularity, activity, adoption, quality, quality_coverage, total, momentum },
  signals: { scorecard: { score, checks, fetched_at } | null,
             osv: { open_vulns } | null, dependents: number | null },
  readme_excerpt,              // ~1.5 KB — the full README comes from the blob store, via backend
  icon,                        // { source, source_url, fetched_at } | null — bytes via backend
  _vectors,                    // v2
  analysis_method, analysis_model, content_hash, signals_used[], indexed_at
}
```

### Hard rules

- **Writes are asynchronous.** Every write returns a task uid; the projector must wait for the
  Meilisearch task before advancing its checkpoint, or a crash will silently lose a batch.
- **`updateDocuments` merges only at the top level** — sending `{score:{momentum:0.4}}` wipes
  the rest of `score`. Send complete sub-objects.
- **Never change settings on the live alias.** Settings changes reindex; apply them to the new
  index before the swap.
- **No joins, no transactions** in Meilisearch — `tools` is fully denormalized; duplication is
  accepted. (Postgres, the write model, has both; that's what it's for. Don't reach for a join in
  Meilisearch when the answer is "query Postgres instead".)
- **Facet distribution is the only aggregation** — category counts come from
  `facets: ['kind','domains']`.
- **Admin listing uses Doctrine, not `search`.** The backoffice's pipeline-health views query
  Postgres directly (offset/limit/filter via `EntityRepository`), not Meilisearch — there's no
  reason to round-trip through a search engine for data that's already relational.
- **The browser key is search-only and scoped to `tools`.** Never ship a bundle with a key that
  can reach anything else, and never ship the master key at all.

## 6. Taxonomy — declared in YAML, never in code

`taxonomy/taxonomy.yaml`, at the repository root — moved out of `packages/core` because it is now
shared **across a language boundary**: `backend/` (PHP) and `apps/web` (JS) both load this same
file directly, rather than importing a shared package. Closed vocabulary; adding a value is a
deliberate PR with rationale in `docs/taxonomy.md`, a rule that detects it and a fixture proving
the rule — not an ad-hoc string. The file is loaded and fully validated at boot on both sides — a
malformed taxonomy takes the Symfony app's container compilation down immediately, and fails
`apps/web`'s build immediately — rather than letting either side classify into a vocabulary that
doesn't exist. `bin/console app:taxonomy:check` runs PHP-side validation standalone; `apps/web`
keeps its own equivalent check in its build.

Eight families, each declaring `id`, `label`, `param` (its URL query parameter), `cardinality`,
`source` and its values. Each value declares `label`, `description`, optional `aliases` (GitHub
topics for `domains`, SPDX ids for `license_class`) and optional `hidden`.

**Assigned by the analyzer:**

- **`kind`** — what the artifact *is* (exactly one): `cli` · `kubectl-plugin` · `operator` ·
  `controller` · `helm-chart` · `crd-library` · `admission-webhook` · `distribution` ·
  `dashboard-ui` · `library-sdk` · `terraform-provider` · `ide-extension` · `service` ·
  `learning-resource`
- **`domains`** — what problem it solves (1–3): `networking` · `security` · `policy` · `storage` ·
  `database` · `observability` · `ci-cd` · `gitops` · `packaging` · `autoscaling` · `scheduling` ·
  `cost` · `multi-cluster` · `backup-dr` · `service-mesh` · `secrets` · `serverless` ·
  `dev-experience` · `testing` · `ai-ml` · `edge` · `troubleshooting`
- **`runtime`** — where it executes (exactly one): `in-cluster` · `workstation` · `ci-pipeline` ·
  `in-your-code` · `cluster-itself` · `hosted-service` · `unknown`

**Proven against a registry:**

- **`install_methods`** — detected, never guessed: `brew` · `mise` · `asdf` · `krew` · `helm` ·
  `kubectl-apply` · `go-install` · `cargo` · `npm` · `pip` · `nix` · `arkade` · `apt` ·
  `container-image` · `curl-script` · `github-release` · `operator-hub`

  Each carries a **verified command** (`brew install k9s`) and a `source_url` proving the entry
  exists in that registry. Unprovable ⇒ not listed. Rendering a `brew install` line for a formula
  that doesn't exist is the single worst bug this project can ship — people paste these into a
  terminal.

**Derived from cached metadata:**

- **`license_class`** — `permissive` · `weak-copyleft` · `copyleft` · `source-available` ·
  `public-domain` · `unknown`
- **`openness`** — `fully-open` · `open-core` · `source-available` · `unknown`
- **`maturity`** — `cncf-graduated` · `cncf-incubating` · `cncf-sandbox` · `established` ·
  `young` · `dormant` · `archived` · `unknown`
- **`governance`** — `foundation` · `vendor-backed` · `community` · `individual` · `unknown`

**Unknown is a real answer.** Every family whose classification can fail declares `unknown` and
defaults to it. Absence of evidence never becomes a positive claim — the same rule §4.3 applies to
a missing Scorecard. `unknown` values are hidden from the UI. `governance` and `maturity` are
seeded from the CNCF Landscape (a weekly bulk fetch of `cncf/landscape`'s `landscape.yml`,
cached as an `ExternalSignal` row): a repo hosted at any level reports
`cncf-graduated`/`cncf-incubating`/`cncf-sandbox` and `foundation` from that seed. An
Organization-owned repo the Landscape doesn't list still defaults to `unknown` governance (a
User-owned repo reports `individual`, and a handful of hardcoded foundation orgs report
`foundation`, regardless of Landscape membership); maturity's fallback for an unlisted repo is
age-based bands (`established`/`young`/`dormant`), not `unknown`. `maturity` checks `archived`
before the CNCF level, so an archived CNCF-graduated project reports `archived`; see
`docs/taxonomy.md` for why.

**The vocabulary is data, so the types are `string`.** `kind` and `domains` are not PHP enums or
TS literal unions; validation is a runtime refinement against the loaded file on both sides
(Symfony Validator in PHP, the equivalent check in `apps/web`). Each rule that can emit a
taxonomy value must have a test asserting the value it emits exists in the file — the PHP
equivalent of `packages/analyze/src/rules/pinning.test.ts`, now under `backend/tests/Unit`.

**Adding a family** means a new `filterableAttribute` on `tools`, which is a settings change,
which means a rebuild and an alias swap (§5). Everything else — `Search`, `Query`, `apps/web`'s
home page chip rows — loops over the file and needs no edit.

## 7. Repository layout

```
keco/
├── apps/
│   └── web/                        # public portal — Vite + React, static SPA (UNCHANGED, §9)
│       ├── src/                    # the browser bundle
│       └── prerender/              # Node build tooling: read model → static HTML
├── backend/                        # the Symfony 8 monolith — replaces apps/api + apps/workers
│   │                                + every packages/* write-side package
│   ├── bin/console
│   ├── config/                     # packages/{doctrine,messenger,easy_admin,security,
│   │                                rate_limiter,scheduler,http_client,html_sanitizer}.yaml
│   ├── migrations/                 # Doctrine — the schema's only history
│   ├── public/index.php            # the one front controller
│   ├── src/
│   │   ├── Entity/  Repository/    # the write model, §3
│   │   ├── Blob/                   # BlobStorageInterface + adapters, §3.1
│   │   ├── Journal/                # JournalEvent + Checkpoint, shared by every consumer
│   │   ├── Discovery/  Crawler/  Analyzer/  Projector/    # write side, §4 — each with
│   │   │                                                  # Message/ MessageHandler/ Console/
│   │   ├── Taxonomy/               # taxonomy.yaml loader + validation, §6
│   │   ├── Search/                 # Meilisearch client wrapper, index defs/settings, §5
│   │   ├── Query/                  # shared retrieval — SearchTools, GetTool, CompareTools,
│   │   │                           # FindAlternatives, WhatsHot
│   │   ├── Api/                    # REST v1 · MCP · chat · readme · icon · admin auth · commands
│   │   ├── Backoffice/             # EasyAdminBundle dashboard + read-only CRUD controllers, §10
│   │   └── Command/                # cross-cutting console commands
│   ├── tests/{Unit,Functional,Fixtures}/    # Fixtures/ = real cached GitHub payloads, committed
│   ├── deptrac.yaml                # import-boundary enforcement — the PHP eslint.config.mjs
│   ├── phpstan.neon
│   └── composer.json
├── taxonomy/
│   └── taxonomy.yaml                # shared by backend/ (PHP) and apps/web (JS), §6
├── infra/                           # compose (dev: Postgres + Meilisearch), Dockerfiles, deploy
└── docs/                            # ADRs, taxonomy rationale, design + implementation plans
```

PHP 8.3+, Symfony 8, strict types (`declare(strict_types=1)` in every file), Doctrine ORM,
Composer. `apps/web` keeps its own toolchain (TypeScript, Vite, pnpm) — the two halves of the repo
are different languages by design now (ADR 0005), not an inconsistency to fix.

**Two deployables.** `apps/web` builds to `dist/`, served as static files by a reverse proxy (or
by Symfony's own `public/` directory in the simplest deployment) at `/`. `backend/` is one
Symfony application serving `/api/*` (JSON) and `/admin` (EasyAdmin, server-rendered) from one
process — no separate backoffice build, unlike the `apps/backoffice` SPA this document used to
describe as not-yet-built. See §10 for why EasyAdmin replaced that plan.

**One Symfony app, several process roles.** `bin/console messenger:consume async_<context>` runs
each write-side bounded context (§4); the web role serves HTTP. All of it is one codebase, one
`composer.json`, one container image, differentiated only by which command the container's
entrypoint runs — the direct descendant of "one Node process in production."

**Import boundaries, enforced by `deptrac.yaml`** (§6 of the migration design spec has the full
rule set; the headline rules):

- `Discovery`/`Crawler`/`Analyzer`/`Projector` may depend on `Entity`, `Repository`, `Blob`,
  `Journal`, `Taxonomy` — never on `Search` or `Query`. An analyzer that queries Meilisearch to
  decide what to work on has broken §2's rule 1.
- `Search` and `Query` may be imported only by `Projector` (write, for upserts) and `Api`/
  `Backoffice` (read). `Query` never imports `Entity`/`Repository`/`Blob`.
- `Api` and `Backoffice` may depend on `Query`, `Entity`/`Repository` (read-only, for pipeline
  observability), `Journal` (checkpoint reset) and the shared `CommandDispatcher` — never on
  `Discovery`, `Crawler`, `Analyzer` or `Analyzer\Signals` directly. The read side reaches the
  write side only by dispatching a message (§11).
- `Analyzer\Signals` may only be imported by `Analyzer`, and every adapter must go through
  `ExternalSignal`'s repository — a provider called without the cache in front of it is a bug.
- `apps/web` is a **browser bundle**: it may import `taxonomy/taxonomy.yaml` and the
  `meilisearch` JS client only. It cannot import anything from `backend/` — there is no shared
  code across the language boundary anymore (§8 of the migration design spec explains the one
  real cost of this: the URL-params-to-filter algebra must be duplicated and kept in sync via a
  shared fixture file, `taxonomy/query-fixtures.json`).
- **`apps/web/prerender` is not bundle code.** It is a Node build step that reads `tools` from
  Meilisearch directly (not through `backend/`) and writes files. It may not touch the write side.

## 8. Commands

Every dev script is a **mise task** — `mise.toml` is the single entry point. `mise tasks` lists
them all; the table below is the map, not the source of truth.

| Command | What it does |
|---|---|
| `mise run setup` | First run: `.env`, `composer install`, `pnpm install` (for `apps/web`), Postgres + Meilisearch up, migrations, index settings, browser search key |
| `mise run web` | Portal dev server (Vite), `apps/web`, unchanged |
| `mise run backend` | `symfony server:start` (or `php -S`/FrankenPHP dev mode) serving `backend/` |
| `mise run dev` | Portal + backend together |
| `mise run web:mock` | Portal alone against the in-browser mock backend — fabricated data, dev/test only (§14), unchanged from before the migration |
| `mise run build` | Build the portal, prerender its top tool pages; `composer install --no-dev` + warm the Symfony cache for `backend/` |
| `mise run prerender` | Emit static tool pages, `sitemap.xml` and `robots.txt` from `tools` — Node, unchanged, reads Meilisearch directly |
| `mise run migrate` | `bin/console doctrine:migrations:migrate` |
| `mise run discovery:sweep -- --query kubernetes --fresh` | `bin/console app:discovery:sweep` — enumerate repos into `DiscoveryRepo`/`DiscoveryState` (resumes by default; `--fresh` deletes the query's corpus and state, never `DiscoveryRun` history) |
| `mise run discovery:list -- runs --limit 20` | `bin/console app:discovery:list runs` — the sweep history |
| `mise run discovery:reset -- --query kubernetes` | Delete a query's `DiscoveryRepo`/`DiscoveryState` rows, keeping `DiscoveryRun` history. Prompts; not rebuildable offline |
| `mise run repo:crawl -- --limit 200` | `bin/console app:repo:crawl` — dispatch `CrawlRepo` for discovered repos |
| `mise run repo:icon -- --repo owner/name` | `bin/console app:repo:icon` — fetch and rasterize one repo's icon, standalone |
| `mise run repo:history -- --limit 20` | `bin/console app:repo:history` — crawl run history: fetched, skipped, failed, GitHub quota spent |
| `mise run repo:analyze` | `bin/console app:repo:analyze` — classify everything with a changed `content_hash` or an expired signal |
| `mise run repo:analyze -- --force-refresh scorecard` | Ignore TTL for one provider |
| `mise run repo:analyze -- --repo owner/name` | Analyze one named repo directly, bypassing the journal |
| `mise run project` | `bin/console app:project` — project `Repo`+`Analysis` into Meilisearch |
| `mise run rebuild` | `bin/console app:project --rebuild` — full offline replay → new index → alias swap, zero GitHub calls |
| `mise run checkpoint:reset -- --consumer analyzer` | `bin/console app:checkpoint:reset` |
| `mise run search:settings` | `bin/console app:search:settings` — apply index settings (idempotent) |
| `mise run search:key` | `bin/console app:search:key` — mint or fetch the browser's search-only Meilisearch key into `.env` |
| `mise run taxonomy:check` | `bin/console app:taxonomy:check` — validate `taxonomy/taxonomy.yaml`, plus `apps/web`'s equivalent check |
| `mise run check` / `lint` / `test` | `phpstan analyse` · `deptrac analyse` · `php-cs-fixer` · `phpunit` (backend) — plus `tsc`/`eslint`/`vitest` for `apps/web`, unchanged |
| `mise run e2e` | `apps/web`'s Playwright suite against the mock backend — unaffected by the migration, still needs no Postgres, no Meilisearch, no `backend/` (§9) |
| `mise run ci` | check + lint + test + taxonomy:check across both halves — the gate for §15 |
| `mise run infra:up` / `infra:down` / `infra:reset` | Postgres + Meilisearch (the two local services now). `infra:reset` drops and recreates the Postgres database and wipes Meilisearch — it prompts with what it is about to lose; pass `--yes` in CI |

`composer.json`'s own `scripts` and `package.json`'s own `scripts` exist only so `composer <name>`
and `pnpm <name>` work from muscle memory; each delegates straight to the matching mise task.

Wiping the write model is now `mise run infra:reset` (drops Postgres) followed by a re-crawl —
it is **not** the free `rm -rf .cache` it used to be, because Postgres is a real database, not a
disposable filesystem cache. It is still fully rebuildable from GitHub, just slower to wipe and
slower to rebuild than deleting files was. The read model (`tools`) is still free to wipe and
rebuild offline via `mise run rebuild` once `Repo`/`Analysis` data exists.

Always run `mise run ci` before declaring work done.

## 9. Portal (`apps/web`) — static SPA, unchanged by this migration

Vite + React, no SSR, no framework routing conventions. The build output is a `dist/` folder
served as static files. `react-router` for client navigation. This entire section describes
behavior that predates the PHP migration and is not affected by it — ADR 0005 records keeping
`apps/web` as-is as a deliberate scope boundary.

**Search is browser → Meilisearch, directly**, unaffected by what backend serves `/api/*`.
`meilisearch-js` with the search-only key, ~80 ms debounce, no backend round-trip per keystroke —
that is the whole reason the search key is public. State is **URL-synced**
(`?q=&kind=&domain=&install=&sort=&view=`) so results are shareable and back/forward work;
list/grid toggle; facet counts from Meilisearch; keyboard navigable (`/` focuses, arrows move,
enter opens). Empty and zero-result states must suggest something useful.

**The filter-building algebra (`buildFilters`, `selectionFromParams`, `defaultFacets`,
`familyAttribute`, sort specs) now lives only in `apps/web`, duplicated in `backend/`'s `Query`
namespace for REST/MCP/chat.** Before the migration these were one shared TypeScript module
(`@keco/core`); crossing the PHP/JS language boundary made literal sharing impossible. Keep both
implementations honest against `taxonomy/query-fixtures.json` (§7, §14) — a taxonomy or
sort-key change is not done until both sides' tests pass against the same fixture file.

**Theme.** Light by default, dark by `prefers-color-scheme`, overridable by a header toggle that
persists to `localStorage`. Tokens live in `apps/web/src/styles/theme.css` and reach Tailwind
through `@theme inline`. **The shell is part of the prerender contract:** an inline, blocking
script in `index.html` marked `keco-theme-bootstrap` stamps `data-theme` before first paint, and
`prerender/html.ts` asserts the built shell still contains it — alongside its assertions on
`<title>`, the meta description and `<div id="root">`. Colour encodes **state, not category** —
accent means "selected", `StatusPill`'s green/amber/red means a real state and always ships an
icon plus a word, and health is a single-hue magnitude ramp with the number beside it.

**Home** — a hero search field, then **Browse**: one chip row per facetable taxonomy family, built
from the `tools` facet distribution fetched at `hitsPerPage: 0`. A value with zero documents
renders no chip. Each chip links to `/search?<param>=<value>` using the family's declared `param`.
Below Browse, **Highest momentum** — the top results from `whatsHot()`, labelled "momentum", never
"trending".

**Tool page** — `/tools/{owner}/{repo}`. Sidebar: stars, forks, language, license, last commit,
latest release, score breakdown with `quality_coverage`, canonical repo link. Install block: one
tab per verified method, copy button, proof link. **Related**: same `kind` + overlapping
`domains`, ranked by score, excluding the same owner. **Who is using it**: only adopters with an
`evidence_url` — no invented logos; hide the section when there's nothing real. Always show
owner, license, and "data from GitHub, updated `<indexed_at>`".

**The README comes from the write side, never from the index** — and the browser cannot reach
Postgres or the blob store, so it comes through `backend/`: `GET /api/readme/{owner}/{repo}`
reads the cached markdown from the blob store and returns **sanitised** HTML
(`symfony/html-sanitizer`), with relative image and link URLs rewritten, the top badge-only
paragraph stripped, and PHP-side syntax highlighting applied server-side. Rendering untrusted
README markdown in the browser without that server-side sanitise step is a stored-XSS hole
across the whole corpus.

**The icon comes the same way, and for the same reason.** `GET /api/icon/{owner}/{repo}/{32|64|160}.png`
serves a PNG the crawler rasterised from the verbatim `icon.src`, so nothing active from a
stranger's SVG ever reaches a reader — the rasterise *is* the sanitise, with `nosniff` and a
`default-src 'none'` CSP behind it. The document's `icon` descriptor says whether one exists, so
an iconless repo renders a deterministic monogram tile and fires no request at all.

### SEO without SSR

A bare SPA is not indexable enough for a search portal whose acquisition channel is organic
search. The replacement is **build-time prerender**, unaffected by the backend's language:

- A Node build step queries `tools` (Meilisearch) for the top N (~1000) by `score_total` and
  emits a real static HTML file per tool page — `<h1>`, `<title>`, meta description, JSON-LD
  `SoftwareApplication`, and the tool's `readme_excerpt` as indexable prose. It renders the *same*
  React route tree the browser mounts, so what a crawler sees and what a reader sees cannot drift.
  A reverse proxy (or whatever serves `apps/web`'s static output) serves that file when the build
  manifest lists the path and falls back to `index.html` otherwise.
- **The full README is not inlined** — it lives in `backend/`, so the prerender stays a pure
  read-model consumer with no write-side access and no second copy of the renderer.
  `readme_excerpt` (~1.5 KB, already in the `tools` document) is what a crawler indexes; the full
  sanitised README arrives client-side from `backend/`'s readme endpoint.
- `sitemap.xml` and `robots.txt` are generated in the same step, from the same query.
- The prerender reads Meilisearch **at build time only**, no dependency on `backend/` being up.
- `/admin` is `noindex` and never prerendered.

**The portal has end-to-end coverage, and it runs with no backend at all.** `mise run e2e` starts
Vite with the mock backend and drives every route through Chromium — unaffected by the migration,
since the mock backend was always a `msw`-based in-browser fake, never a call to `apps/api`.
**That coverage is a floor, not a snapshot** — every route, control and state a reader can reach
carries an e2e test, and anything added here adds one in the same change.

## 10. Backoffice (`/admin`, inside `backend/`) — observe and command, never edit

EasyAdminBundle, server-rendered inside the same Symfony app — not a separate SPA build. There is
no curation, so the backoffice has exactly two jobs: **show what the pipeline did**, and **issue
commands**.

1. **Pipeline health** — from `Repo`, `Analysis`, `JournalEvent`, `DiscoveryRun`,
   `CrawlHistoryEntry`: counts by phase, repos failing, repos skipped and why, classification
   confidence distribution, GitHub quota remaining, checkpoint lag per consumer.
2. **Repo inspector** — `Repo.raw_payload`, the README (from the blob store), the tree, the
   `Analysis` row with its rules trace or LLM output, and the projected `tools` document side by
   side, all read-only.
3. **Commands** — buttons that append a `JournalEvent` or reset a `Checkpoint`: re-crawl this
   repo, re-analyze this repo, re-analyze everything with `confidence < 0.7`, rebuild the index,
   promote/rollback an alias. They dispatch a Messenger message and return immediately through
   the same `CommandDispatcher` service `Api\Controller\CommandsController` uses (§11) — they
   never do the work inside the admin request either.
4. **Taxonomy** — vocabulary with corpus facet counts (queried from `tools`, the only place these
   counts belong). A category with 3 or 4000 tools is a taxonomy bug.
5. **Chat traces** (v2) — `ChatTrace` rows, to drive eval fixtures.

**There is no "edit this field" form, and adding one is out of scope — this is the one place
EasyAdminBundle needs active resistance, not just absence of effort.** EasyAdmin's whole value
proposition is fast CRUD scaffolding; every `CrudController` registered here **must** disable
`NEW`, `EDIT` and `DELETE` actions explicitly (`Actions::new()->disable(...)`) and expose only
`INDEX`/`DETAIL`. A per-repo override is a second source of truth that survives no rebuild and
silently diverges from the analyzer. The fix for a misclassification belongs in the analyzer's
rules, where it improves every similar repo at once — and where a fixture can prove it. That is
the whole reason curation was cut (§1), and it is a **more tempting mistake now than it was in
the old design**, because EasyAdmin makes an edit form the path of least resistance. Don't take it.

## 11. `backend/` — REST, MCP, chatbot, commands

The same Symfony application as the write side, under `src/Api`. JSON-only for its own endpoints.
It holds the **only** copy of the Meilisearch master key and the only Postgres/blob-store handle
on the read side.

Three machine front doors, **one implementation**: `src/Query` holds all retrieval and exports
`searchTools() · getTool() · compareTools() · findAlternatives() · whatsHot()`. REST, MCP and
chat are thin adapters over it. A capability in one and not the others is a bug.

`apps/web` is the deliberate exception: §9 has it querying Meilisearch from the browser with the
search-only key directly, never through `backend/`. Since the two halves no longer share a
language, the filter-building algebra `Query` and `apps/web` both need is duplicated and kept
honest by `taxonomy/query-fixtures.json` (§8, §14) — there is no `@keco/core` equivalent that can
be imported by both anymore.

**REST** — `/api/v1/*`, read-only, anonymous, CORS-open, IP rate-limited (Symfony `RateLimiter`).
Public identifier is `owner/repo`; never leak internal database ids.

**MCP** — `/api/mcp`, streamable HTTP, read tools only.

- Tool *descriptions* are the interface — an agent picks from the description alone. Say
  explicitly when not to use each tool.
- Compact structured content: `search_tools` caps at 10 results with ~40-word summaries. A 50 KB
  response burns the caller's context and gets Keco dropped from their toolset.
- Every item carries `url` (Keco page) + `repo_url` so agents can cite, and `indexed_at` so they
  know freshness.

**Chatbot** — `/api/chat`, strictly retrieval-grounded:

1. Retrieve first (Meilisearch hybrid: keyword + embeddings), answer only from what came back.
2. Never name a tool outside the retrieved set. Never emit an install command not in that tool's
   verified `install_methods`.
3. Every recommendation renders as a tool card linking to its Keco page.
4. Weak retrieval ⇒ say so, offer "possibly related", don't pad.
5. Flag archived or stale suggestions.
6. Stateless, no history, no PII, per-IP rate limit, hard token budget per request.
7. Log `(query, retrieved_ids, answer)` to `ChatTrace` (Postgres, not Meilisearch — §5); evals
   with ~50 real devops questions and expected tools.

**Commands** — `/api/commands/*`, the only write path in the whole read side, and it writes to
the *write* model: through the shared `CommandDispatcher` (§10), it appends a `JournalEvent` or
resets a `Checkpoint`, then returns. It never touches Meilisearch and it never does the work
inline. A route handler that loops over repos is always a bug.

**No `POST /log-search`.** Logging every query into a searchable index for a "top searches" view
is not in this design: it is a write on the read path (§2), it makes the browser's public key a
write vector or forces a round-trip that defeats search-as-you-type, and it stores user-derived
data in a system that otherwise holds nothing but public GitHub facts. If query analytics become
necessary, they arrive as a separate decision with a retention policy.

## 12. Auth & secrets

- **Backoffice auth is a single admin credential**, not a full auth system: a custom Symfony
  security authenticator compares against a hashed password (`ADMIN_PASSWORD_HASH`, via
  Symfony's `PasswordHasher`) with a constant-time comparison and sets a signed, `HttpOnly`,
  `SameSite=Strict` session cookie. There is one admin, the backoffice can only read and enqueue,
  and an OAuth provider would be more moving parts than the surface justifies.
- **Authorize inside every controller/handler**, not only in a firewall config. A route that
  trusts an upstream guard is one config change away from being unguarded — a Symfony `access_control`
  entry is necessary but not sufficient; check the admin session or command token explicitly in
  the controller too.
- `/api/commands/*` and EasyAdmin's command actions: admin session **or** `Bearer $COMMAND_TOKEN`
  compared with a constant-time comparison, no CORS.
- **Meilisearch**: master key server-side only, in `backend/`'s environment (via Symfony's
  secrets vault — `bin/console secrets:set MEILI_MASTER_KEY` — for anything beyond local dev).
  The browser bundle gets `VITE_MEILI_SEARCH_KEY` — search-only, scoped to `tools`.
- **`VITE_`-prefixed variables are inlined into `apps/web`'s bundle at build time, permanently, in
  every deployed artifact.** This rule is completely unaffected by the backend's language — never
  prefix a secret with `VITE_`, never read `process.env` from frontend code expecting it to stay
  server-side.
- **`backend/`'s own secrets** go through Symfony's secrets vault in any non-local environment,
  not plain `.env` — `.env` stays for local development and for documenting which variable each
  surface reads (`.env.example` stays in sync, with a comment naming the consumer).
- The blob store is local disk today, so `backend/`'s access is convention plus deptrac, not a
  credential. When object storage lands, it becomes a credential — write the code as if it
  already were one.

## 13. Conventions

- Validate every external payload at the boundary — Symfony Validator + typed DTOs on the PHP
  side, `raw_payload jsonb` is the one deliberate escape hatch (verbatim GitHub JSON, §3), never
  a general permission to skip validation. `mixed` outside that boundary is a PHPStan-level error
  (`phpstan.neon` at max level), the direct descendant of "`any` is banned."
- A single bad repo must never abort a run: catch per item in the message handler, append
  `JournalEvent{type: RepoFailed}`, return success to Messenger rather than rethrowing (§4).
- Structured logging via Monolog: one debug line per repo, one info summary per batch, checkpoint
  position in every summary.
- Tests: unit-test the analyzer against `backend/tests/Fixtures/*.json` — real cached GitHub
  payloads, committed. **A new classification rule requires a fixture proving it.** PHPUnit is
  the default test runner (`symfony/test-pack`); Pest is an acceptable substitute if a plan says
  so, but pick one per bounded context and don't mix them within it.
- **Every `apps/web` change ships end-to-end coverage** — this rule predates and is unaffected by
  the migration. A behaviour a reader can reach — a route, a control, a state, a keyboard path —
  is not delivered until a Playwright test drives it in a browser.
- **A `deptrac` violation is a build failure, not a warning to fix later.** It is the PHP
  equivalent of the eslint import-boundary rules the original TypeScript scaffold enforced, and it
  is what makes §2's CQRS rules checkable rather than aspirational.
- Design and implementation plans live in `docs/`; ADRs in `docs/adr/`. A decision that reverses
  one of these gets an ADR, not a silent edit — this document's own migration is `docs/adr/0005`.
- Conventional Commits scoped by bounded context: `feat(analyzer): …`, `fix(projector): …`,
  `feat(web): …` for the unchanged portal.

## 14. Things that will bite you

**CQRS and the pipeline**

- **Reading a read model from the write side.** The tempting shortcut is "let the analyzer query
  Meilisearch for repos needing work." Don't — the journal and `Checkpoint` exist for this, and
  the coupling is very hard to unwind later. `deptrac` catches the import; it doesn't catch a
  handler that reaches `Search` through a service that itself looks legitimate, so review for
  intent, not just for the import line.
- **Full-table-scanning Postgres to find work** is the direct successor to "listing the cache to
  find work," and it's worse now: an unindexed scan on `journal_events` or `Repo` doesn't just
  cost time, it holds row locks other Messenger consumers are waiting on. Read `journal_events`
  by an indexed range query.
- **A `raw_payload` that gets transformed before storage.** The entire point of keeping GitHub's
  response verbatim in that column is that a parsing bug is fixed by re-deriving, not re-crawling.
  A migration or a fixup script that "cleans up" `raw_payload` in place destroys that property
  silently — normalize into other columns, never mutate `raw_payload` itself.
- **A third-party call without `ExternalSignal`'s cache in front of it** turns a replay into a
  30k-request storm and gets your IP throttled by Scorecard or Artifact Hub.
- **A Messenger handler that rethrows on a single repo's failure.** That hands the failure to
  Messenger's retry policy and eventually its failure transport — which is the wrong place for a
  per-repo problem to live. Catch it, journal it, move on (§4).
- **Signal freshness drifts from repo freshness**: a repo unchanged for a year still needs its
  Scorecard refreshed weekly. Analysis is triggered by `content_hash` change *or* by the oldest
  signal's TTL expiring — not by `content_hash` alone.

**The language boundary**

- **The filter-building algebra can no longer be literally shared.** Before the migration,
  `@keco/core` let the portal and the API import one TypeScript implementation of
  `buildFilters`/`selectionFromParams`/`defaultFacets`. PHP and JavaScript cannot share a module.
  Two implementations now exist, on purpose, kept honest only by `taxonomy/query-fixtures.json`
  and the tests both sides run against it (§8, §9). A sort-key or filter rule that changes in one
  side and not the other is a silent drift bug with no compiler to catch it — this is a real,
  ongoing cost of the split, not a one-time migration task.
- **`taxonomy/taxonomy.yaml` has two independent loaders now.** They must both fail loudly on a
  malformed file (§6) — a loader that silently tolerates an unknown value on one side while the
  other rejects it is how a taxonomy bug ships to only half the system.

**GitHub**

- **The analyzer's GitHub calls come out of the crawler's quota** (`GITHUB_QUOTA_CRAWLER_SHARE`).
  Budget them explicitly or use a second token, or a busy analyzer starves the crawler.
- **Search and core REST have separate, very different limits.** ~30 req/min for Search vs 5000
  points/hour for core. Discovery has its own pacer for exactly this reason.
- The 5000 points/hour budget is shared across every consumer process on a transport. Don't add
  more `messenger:consume` replicas than the quota supports; give each replica set its own token
  or divide the budget in configuration.
- **Scorecard coverage is partial** — OpenSSF only scans its weekly cron set, so most niche repos
  have no score. Absence must renormalise the quality axis, never score as zero.

**Meilisearch**

- **Writes are async** — advance the checkpoint only after the write task completes, or a crash
  loses a batch silently.
- **Partial updates are a shallow merge** — whole sub-objects only.
- **Deep pagination is capped** by `pagination.maxTotalHits`; admin listing uses Doctrine instead
  of `search` entirely now (§5), which sidesteps this for the backoffice specifically.

**Frontend and API**

- **`VITE_`-prefixed variables are baked into the shipped bundle.** A secret with that prefix is a
  published secret, and rotating it means rebuilding and redeploying `apps/web`. Unaffected by the
  migration.
- **The mock backend is development and test only** (`apps/web/src/mocks`, `mise run web:mock`).
  Nothing about this changes with the backend language — the same five layers (dev-only guard,
  devDependency, lint rule, `dist/` scan, gitignored worker script) keep it out of production.
- **The SPA has no server of its own.** A deep link like `/tools/argoproj/argo-cd` only resolves
  because whatever serves `apps/web`'s static output falls back to `index.html` (or to a
  prerendered file). Add a route in the client and confirm the fallback still covers it.
- **SEO is prerender-only.** A change that makes the tool page depend on runtime-only data
  removes it from the index.
- **README markdown is untrusted input.** Sanitise server-side in `backend/`
  (`symfony/html-sanitizer`), never render raw markdown in the browser.
- **EasyAdmin's default is CRUD, and this backoffice has none.** Every `CrudController` here must
  explicitly disable `NEW`/`EDIT`/`DELETE` (§10) — forgetting this on a new controller quietly
  reopens the curation door §1 and §10 both close.
- **A Messenger handler is not a request handler.** Long work belongs in a handler consumed by a
  worker process, never inline in an `Api\Controller` action — a `foreach` over 10k repos in a
  controller is always a bug, same as it was in the old Fastify handlers.

**Corpus quality**

- Plenty of repos mention Kubernetes without being ecosystem tools (courses, blogs, dotfiles).
  `k8s_relevance` demotes them: keep them in Postgres, filter them out at projection time.
- Homebrew formula names rarely match repo names (`ahmetb/kubectx` → `kubectx`). Verify against
  the Homebrew API, and cache that response as an `ExternalSignal` row.

## 15. Definition of done

1. `mise run ci` green across both halves — `backend/`'s PHPStan/deptrac/PHPUnit and `apps/web`'s
   tsc/eslint/vitest, plus `taxonomy:check` on both loaders.
2. Analyzer changes: re-run over the fixture set, diff the classification output, no unexplained
   regressions. New signal provider ⇒ cached (`ExternalSignal`) adapter, TTL, timeout, null-path
   tested.
3. Read-model changes: applied by re-projecting from Postgres — **no network calls at all** — and
   promoted by alias swap, never in place.
4. API changes: contract updated in `src/Query` (the PHP side) **and** in `apps/web`'s own
   filter-building code where the change touches shared vocabulary — remember §8/§14, these no
   longer update together automatically.
5. Portal changes: `mise run e2e` green, including a test for the behaviour just added or
   changed. The tool page still prerenders with a real `<h1>`, metadata and JSON-LD; search is
   keyboard-navigable; no `VITE_`-prefixed secret entered the bundle.
6. Backoffice changes: any new `CrudController` has `NEW`/`EDIT`/`DELETE` explicitly disabled.
7. Nothing on the read side writes a read model; nothing on the write side reads one; `deptrac`
   passes.
8. Update this file when a contract changes; `docs/` when the taxonomy changes; `docs/adr/` when
   a decision here is reversed.
