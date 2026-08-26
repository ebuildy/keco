# AGENTS.md — Keco

Instructions for AI coding agents working in this repository. Read this fully before touching
code.

## 0. Where the code is vs. where this document points

The write side (`packages/*`, `apps/workers`) and the read side (`apps/web`, `apps/api`) both
match this document. One deployable named in §7 does not exist yet: **`apps/backoffice`**.

While it is missing:

- `/admin` is served as a `noindex` 404 by `apps/api`. The routes the backoffice will call —
  `/api/admin/*` and `/api/commands/*` — already exist, because they are the contract, not
  the UI.
- §10 describes what that SPA must be when it lands. Nothing in it is built; nothing in it is
  cancelled.
- `/api/commands/*` authenticates and validates, then returns 501: the journal append is the
  open piece.

Two smaller gaps, both tracked in ROADMAP.md rather than here: `/api/mcp` and `/api/chat` are
declared and unimplemented, and the portal's search page is the ported baseline — no facet
sidebar, no keyboard navigation, no styling system.

## 1. What Keco is

Keco is a search portal for the **Kubernetes ecosystem**. Everything it shows is derived from
public GitHub data: workers pull repositories into a raw cache, analyzers classify and score
them from that cache, and the result is projected into Meilisearch, which the portal, the API
and the MCP endpoint read.

**The product is the data quality.** A beautiful UI over a badly classified corpus is
worthless. When in doubt, invest in the analyzers, not the frontend.

Non-goals — do not build these:

- A database. There is none. See §2.
- Human curation, overrides, moderation queues, editorial content.
- Historical metrics, time series, star history.
- End-user accounts, comments, votes. The portal is anonymous and read-only.
- Hosting packages or proxying downloads.
- Heavy infrastructure. No Redis, no queue system, no Turborepo, no SSR framework. If a problem
  looks like it needs one at this scale, it usually needs a smaller loop instead.

Everything is reproducible from GitHub. Nothing in this system is precious.

### Developer workflow

Tools and runtimes are installed by **mise** (`mise.toml` pins Node and pnpm). Every dev script
is a mise task; nothing is invoked ad-hoc. `mise tasks` lists them, §8 explains them.

The roadmap — what is done, what is next, and what is deliberately not planned — is
[ROADMAP.md](./ROADMAP.md). Check it before proposing work: several obvious-looking gaps
(object storage, curation, star history) are decisions, not omissions.

## 2. CQRS — the organising principle

**Read this before writing any code. Every design question is answered by it.**

```
        ┌──────────────────── WRITE SIDE (commands) ─────────────────────┐
        │                                                                │
 GitHub │ discovery ─▶ crawler ─▶ CACHE ─▶ analyzer ─▶ CACHE ─▶ projector │
  API   │ (enumerate)  (fetch)    (raw)   (classify)  (analysis) (build)  │
        │                    └──── journal of events ────┘                │
        └────────────────────────────────┬───────────────────────────────┘
                                         │ project
        ┌────────────────────────────────▼───────────────────────────────┐
        │  READ MODELS — Meilisearch                                     │
        │  `tools` (public)    `repos_state` (admin)    `traces` (v2)    │
        └────────────────────────────────┬───────────────────────────────┘
                                         │ query only
              apps/web · apps/backoffice · apps/api (REST · MCP · chat)
```

The rules, in priority order:

1. **The write side never reads a read model.** An analyzer that queries Meilisearch to decide
   what to work on has broken the pattern — it uses the journal and its own checkpoint. This is
   the mistake to watch for; it is subtle and it couples everything back together.
2. **The read side never writes.** No page, API route or MCP tool mutates anything. If a read
   path needs to write, the design is wrong. The two deliberate exceptions are named in §11
   (command enqueue) and they only append an event or reset a checkpoint — they never touch a
   read model.
3. **Read models are disposable.** `tools` is rebuildable from the cache by replay, offline, in
   minutes, with zero GitHub calls. If a change can't be applied by re-projecting, it isn't
   done right.
4. **The cache is the write model, and everything fetched goes through it.** Raw GitHub JSON,
   README markdown, and every external signal response — verbatim, keyed, TTL'd. Workers may
   call the network freely; they may never call it twice for the same thing.
5. **Commands are asynchronous and idempotent.** Workers never call each other, never block on
   each other, never share a transaction. They communicate only through the cache and the
   journal.
6. **The two models have different shapes.** The write model is verbose raw GitHub payloads;
   the read model is a flat, denormalized document optimized for search. Never leak the raw
   shape into `tools`, never store search-shaped documents in the cache.
7. **Eventual consistency is the contract.** A repo crawled now appears in search minutes
   later. Every read model document carries `indexed_at`; the UI shows freshness rather than
   pretending it's live.

## 3. The cache (write model)

A directory on disk (`.cache/`, `CACHE_DIR`), behind the `Storage` port in `packages/cache`.
No database, no index, no queries: keys only.

**There is exactly one adapter today — the filesystem.** Object storage (R2/S3) is a v1
operations item and slots in behind the same port when a deployment needs it; see ROADMAP.md.
Do not add an S3 client "for later", and do not write code that assumes either backend:
everything goes through `Storage`, so the swap must be a one-file change with no caller
touched. A relative `CACHE_DIR` resolves against the workspace root, not the process's cwd, so
every worker and `apps/api` share one cache.

```
cache/
├── discovery/                       # enumeration artifacts, keyed by query + window
│   ├── {query}/state.json           # resume position: last completed window
│   └── {query}/{window}.yaml        # the repos that window yielded
├── repos/{owner}/{repo}/
│   ├── repo.json           # GitHub repo API response, verbatim
│   ├── readme.md           # raw markdown, verbatim
│   ├── readme.json         # { path, branch, etag, image_base_url }
│   ├── tree.json           # file tree (paths only, truncated flag)
│   ├── releases.json       # latest N releases
│   ├── manifests/          # go.mod, Chart.yaml, package.json, Cargo.toml… when present
│   ├── icon.src            # icon bytes, verbatim; the real content type is in icon.json
│   ├── icon-{32,64,160}.png # derived with sharp — re-derivable offline, never re-crawled
│   ├── icon.json           # { source, source_url, content_type, bytes, etag, sizes, fetched_at, error }
│   └── _fetch.json         # { etags, fetched_at, content_hash, source }
├── external/{provider}/{key}.json   # every third-party response + { fetched_at, ttl, status }
├── analysis/{owner}/{repo}.json     # analyzer output, schema-validated
├── journal/{YYYY-MM-DD}/{ulid}.json # append-only events
└── checkpoints/{consumer}.json      # { last_event_id, updated_at }
```

- **Verbatim means verbatim.** Never transform on write. Parsing happens downstream, so a
  parser bug is fixed by re-analyzing, not re-crawling.
- **Writes are atomic.** Write to a temp key, then rename. A half-written `repo.json` is
  indistinguishable from a complete one on the next run, and the next run is the whole recovery
  story.
- **`content_hash`** = hash(repo.json core fields + readme + tree). It is the change signal for
  the entire pipeline. Unchanged hash ⇒ no analysis, no LLM call, no re-projection. This is the
  single most important cost control in the system.
- **Never LIST to find work.** A directory scan is merely slow today; the same code against
  object storage is slow *and* billed per request. The journal exists precisely so consumers
  read an ordered stream instead of scanning the cache.

### The journal

Append-only, one small JSON per event, keys sortable by ULID so a consumer can resume from an
offset:

```ts
type Event =
  | { type: 'RepoDiscovered'; repo: string; source: string }
  | { type: 'RepoFetched';    repo: string; content_hash: string; changed: boolean }
  | { type: 'RepoAnalyzed';   repo: string; content_hash: string; confidence: number }
  | { type: 'RepoSkipped';    repo: string; reason: string }
  | { type: 'RepoFailed';     repo: string; phase: string; error: string }
```

Each consumer keeps its own checkpoint. Replay is normal operation, not an incident: reset the
checkpoint and everything downstream rebuilds. Events are facts about the past — never edit or
delete one.

## 4. Workers (write side)

Four independent processes. **They never talk to each other.** Each is a loop: read events from
its checkpoint → do work → write cache → append events → advance checkpoint.

| Worker | Consumes | Produces | Network | Cadence |
|---|---|---|---|---|
| **discovery** | keyword queries, search windows | `discovery/{query}/**` | GitHub Search (paced) | periodic sweep, resumable |
| **crawler** | seed lists, `discovery/{query}/repos-full-list.yaml` | `repos/**`, `RepoFetched` | GitHub (rate-limited) | continuous, full sweep weekly |
| **analyzer** | `RepoFetched` where `changed`, or an expired signal TTL | `analysis/**`, `RepoAnalyzed` | signal providers + LLM, **all cached** | continuous |
| **projector** | `RepoAnalyzed` | Meilisearch `tools`, `repos_state` | none | continuous, batched |

Concurrency is `p-queue` (≈8) with `p-retry` per task, in-process. There is no Redis, no BullMQ
and no broker: the filesystem is the job state, and a crashed run resumes from its checkpoint.
Scheduling is `node-cron` inside an always-on container next to Meilisearch (`infra/compose.yml`),
not GitHub Actions — the cache lives on a real volume, not in git.

Consequences that matter:

- The analyzer **may** call the network — Scorecard, deps.dev, registries, GitHub for signals
  the crawler didn't collect. But every call goes through the TTL cache in `external/`, so a
  *replay* is nearly free: rule changes, prompt changes and taxonomy changes can be re-run over
  the whole corpus without a network storm. Keep that property; it's what makes the pipeline
  cheap to iterate on.
- The projector is pure: cache in, index out, no network. It must stay that way — it is the
  thing you re-run most often.
- The projector is the only writer to Meilisearch. Nothing else writes to it, ever. The one
  exception is `engine seed` (`apps/workers/src/engine`), dev-only tooling that pushes
  `infra/mock/corpus.json` into a local index so the search engine can be exercised before
  the projector fills it: it consumes no journal, advances no checkpoint and writes only
  sentinel-stamped fixtures. It refuses a non-local `MEILI_HOST` (§8).
- Scale out by **deterministic sharding** (`hash(repo) % SHARD_COUNT == SHARD_INDEX`), not by
  locks or leases. There is no coordination primitive here and you must not invent one.
- Every worker is safe to kill at any moment. Crash mid-batch ⇒ checkpoint not advanced ⇒
  reprocess ⇒ same result. If a worker isn't crash-safe, it's wrong. `apps/workers/src/lib/
  shutdown.ts` owns the signal handling; use it rather than adding another `process.on('SIGINT')`.

### 4.1 discovery

Enumerates candidate repos; it does not fetch them. GitHub Search returns **at most 1000 results
per query**, so the unit of work is a *window*: a query narrowed by a `stars:` band and a
`created:` range small enough to stay under the cap. `windows.ts` is the calendar algebra that
builds and splits windows, `plan.ts` decides split-vs-paginate for a probed window, `sweep.ts`
holds the resume-vs-new-sweep transition, `store.ts` writes the YAML artifacts and the resume
state.

**Discovery appends no journal events.** It publishes files, and the crawler reads
`discovery/{query}/repos-full-list.yaml` directly. This is a deliberate exception to §2's
event-flow contract: a weekly sweep would otherwise write ~100k tiny journal entries, and the
artifact is directly inspectable. The delta is already computed in `_hashes.json`, so emitting
`RepoDiscovered` later is a small additive change if the crawler ever needs a resumable offset.

- **Resume by default.** A sweep continues from `discovery/{query}/state.json`; `--fresh` is the
  explicit opt-out. `--limit` stops at the first window boundary past N, so it overshoots — it is
  a dev-run convenience, not a budget.
- **Change-gated writes.** A window whose result set is byte-identical is not rewritten, so a
  re-sweep produces no journal churn.
- Discovery has its own rate pacer in `@keco/github` — the GitHub Search API is limited far more
  tightly (~30 req/min authenticated) than the core REST API, and mixing the two budgets stalls
  both.

### 4.2 crawler

Fetches everything discovery and the seed lists named, into `repos/**`:

- Seed from registries first — higher signal than keyword search: CNCF landscape
  (`cncf/landscape`), krew index (`kubernetes-sigs/krew-index` → `plugins/*.yaml`), Artifact Hub
  API, OperatorHub / `k8s-operatorhub/community-operators`, curated `awesome-*` lists.
- GraphQL for bulk metadata (≤100 repos/query — far cheaper against the 5000 points/hour
  budget); REST only for README, tree, releases.
- `ETag` / `If-None-Match` on everything: a 304 costs no quota and short-circuits to
  `RepoFetched{changed:false}`.
- Honour `x-ratelimit-remaining`, exponential backoff on 403/429, respect `retry-after`. A
  crawl that gets the token throttled is a failed crawl.
- Skip: forks (unless > 200 stars and diverged), archived + stale > 24 months (unless > 1000
  stars), repos whose only Kubernetes link is a CI manifest. Emit `RepoSkipped` with a reason —
  never drop silently.

### 4.3 analyzer — rules first, external signals, AI as fallback

Three passes over each repo, cheapest first. Local rules settle most of it; external providers
add what GitHub metadata can't tell you; the LLM only sees what's left ambiguous.

#### Pass 1 — local rules (cache only, free)

Deterministic signals settle most repos, free and reproducible:

- `topics[]`; name patterns (`kubectl-*`, `*-operator`, `*-controller`)
- Tree: `Chart.yaml` → helm-chart · `config/crd/` + `PROJECT` → operator (kubebuilder) ·
  `.krew.yaml` → kubectl-plugin · `cmd/` + cobra → cli
- Manifests: `sigs.k8s.io/controller-runtime`, `k8s.io/client-go` (go.mod), `kube`
  (Cargo.toml), `@kubernetes/client-node` (package.json)
- README badges/headings → install *candidates*, to be verified in pass 2

#### Pass 2 — external signals (`packages/signals`)

Things GitHub's repo API cannot tell you. Every provider is a small adapter with a **fixed TTL**
and a **hard timeout**, and every response lands in `external/{provider}/{key}.json`.

| Provider | Gives | TTL |
|---|---|---|
| **OpenSSF Scorecard** (`api.securityscorecards.dev`) | maintenance, code review, CI tests, signed releases, branch protection, dangerous workflows, known vulns | 7 d |
| **deps.dev** (`api.deps.dev/v3`) | project metadata, Scorecard mirror, dependency/dependent counts across ecosystems | 7 d |
| **OSV.dev** | known vulnerabilities affecting the project | 3 d |
| **Homebrew** (`formulae.brew.sh/api/formula.json`) | proof a formula exists + exact name | 1 d, one bulk file for the whole corpus |
| **krew index**, **Artifact Hub**, **OperatorHub** | proof of plugin/chart/operator publication | 1 d |
| **GitHub** (extra) | contributors, dependents, release cadence, community profile | 7 d, **shares the crawler's quota** |

Rules, all mandatory:

- **Cache first, always.** A cache hit inside TTL never hits the network. `--force-refresh` is
  the only bypass and it is a manual, per-provider flag.
- **Bulk over per-repo** wherever the provider allows it. Fetching `formula.json` once per
  corpus run is right; fetching it per repo is 30k requests for the same file.
- **Degrade, never fail.** A provider that times out, 404s or rate-limits produces
  `signals.{provider} = null` plus an entry in `partial_signals[]`. Write the analysis anyway,
  emit `RepoAnalyzed` with `partial: true`, and let the next run fill the gap. A dead third
  party must never stall the pipeline or block indexing.
- **Missing ≠ bad.** Scorecard only covers projects in OpenSSF's weekly cron set, so most
  small repos have no score at all. Treat absence as *unknown* and renormalise the quality axis
  over the signals you actually have — never as a zero. Scoring a repo badly because a third
  party never looked at it is a silent, corpus-wide bias.
- **GitHub calls here share the crawler's 5000 points/hour**, split by
  `GITHUB_QUOTA_CRAWLER_SHARE` (default 0.8). Change the split in config or use a second token;
  two components spending the same quota without a contract is how crawls start failing at 3am.
- Record every provider's `fetched_at` in the analysis document. A score you can't date is a
  score you can't defend.

#### Pass 3 — LLM fallback

Only when confidence < 0.7 or `kind` is ambiguous: README first 8 KB + topics + tree + the
signals from pass 2, requiring **structured output validated by `AnalysisSchema`**. Invalid →
retry once → fall back to `kind: 'service'`, `confidence: 0.3`, `needs_review: true`. Free text
never leaves the analyzer. Model is `ANALYZER_MODEL`, and it is a cheap one on purpose — pass 3
should be a minority of the corpus, and if it isn't, the fix is a rule, not a bigger model.

Every analysis document records `method` (`rules` | `signals` | `llm`), `model`, `content_hash`,
`signals_used[]` and `partial_signals[]` — so any classification can be explained, dated and
reproduced.

### 4.4 projector

Reads `repos/**` + `analysis/**`, computes scores, builds the read model, upserts in batches of
≤1000, awaits the Meilisearch task, advances the checkpoint.

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

**On "trending":** with no history, true star velocity is unavailable. `momentum` (stars per
day of age, damped by recent activity) is the honest substitute — it surfaces fast-growing
young projects without pretending to measure a 30-day delta. Label it "momentum" in the UI, not
"trending this week". Do not fake a time series.

**Full rebuild** = build `tools_<ts>` from cache, apply settings, verify document count, swap
the alias, keep the previous index for one cycle for instant rollback. Never mutate the live
alias, never swap onto a half-built index.

## 5. Read models (Meilisearch)

| Index | Consumer | Searchable | Contents |
|---|---|---|---|
| `tools` (alias → `tools_<ts>`) | portal, REST, MCP, chat | yes | the public corpus, < 8 KB/doc |
| `repos_state` | backoffice only | `[]` | per-repo pipeline status: fetched_at, analyzed_at, content_hash, last error, skip reason |
| `traces` | backoffice only (v2) | `[]` | chat query + retrieved ids |

`searchableAttributes: []` makes an index a plain key-value store: no inverted index, minimal
RAM, still filterable and retrievable. Use it for everything that isn't the search corpus.

`repos_state` is a **second read model over the same events**, not a database table — that's why
the backoffice can exist without giving anyone write access to anything.

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
  readme_excerpt,              // ~1.5 KB — the full README comes from the cache, via apps/api
  icon,                        // { source, source_url, fetched_at } | null — bytes via apps/api
  _vectors,                    // v2
  analysis_method, analysis_model, content_hash, signals_used[], indexed_at
}
```

### Hard rules

- **Writes are asynchronous.** Every write returns a task uid; the projector must `waitForTask`
  before advancing its checkpoint, or a crash will silently lose a batch.
- **`updateDocuments` merges only at the top level** — sending `{score:{momentum:0.4}}` wipes
  the rest of `score`. Send complete sub-objects.
- **Never change settings on the live alias.** Settings changes reindex; apply them to the new
  index before the swap.
- **No joins, no transactions.** `tools` is fully denormalized; duplication is accepted.
  Anything structural is a rebuild + swap.
- **Facet distribution is the only aggregation** — category counts come from
  `facets: ['kind','domains']`.
- **Admin listing uses `getDocuments`** (offset/limit/filter), not `search`, which is capped and
  relevance-ordered.
- **The browser key is search-only and scoped to `tools`.** Never ship a bundle with a key that
  can reach `repos_state` or `traces`, and never ship the master key at all.

## 6. Taxonomy — declared in YAML, never in code

`packages/core/taxonomy.yaml`. Closed vocabulary; adding a value is a deliberate PR with
rationale in `docs/taxonomy.md`, a rule that detects it and a fixture proving the rule — not an
ad-hoc string. The file is loaded and fully validated at module init; a malformed taxonomy takes
every worker and every frontend build down immediately rather than letting them classify into a
vocabulary that does not exist. `mise run taxonomy:check` runs that validation standalone.

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
a missing Scorecard. `unknown` values are hidden from the UI. `governance` in particular will
report `unknown` for most real foundation projects (etcd-io, containerd, helm, prometheus,
cilium) until the CNCF landscape crawler ships a cached seed — an org account alone proves
nothing. `maturity` checks `archived` before the CNCF level, so an archived CNCF-graduated
project reports `archived`; see `docs/taxonomy.md` for why.

**The vocabulary is data, so the types are `string`.** `Kind` and `Domain` are not literal
unions; validation is a zod refinement against the loaded file. The compile-time check is replaced
by `packages/analyze/src/rules/pinning.test.ts`, which asserts every value a rule can emit exists
in the file. If you add a rule, that test is how a typo gets caught.

**Adding a family** means a new `filterableAttribute`, which is a settings change, which means a
rebuild and an alias swap (§5). Everything else — `packages/search`, `packages/query`, the home
page chip rows — loops over the file and needs no edit.

## 7. Repository layout

```
keco/
├── apps/
│   ├── web/                       # public portal — Vite + React, static SPA
│   │   ├── src/                   # the browser bundle
│   │   └── prerender/             # Node build tooling: read model → static HTML
│   ├── api/                       # Fastify — the only backend process
│   │   └── src/routes/            # v1 · mcp · chat · readme · admin · commands
│   └── workers/
│       └── src/{discovery,crawler,analyzer,projector,replay,lib}/
├── packages/
│   ├── core/                      # zod schemas, taxonomy, scoring, event types
│   ├── cache/                     # Storage port + fs adapter, journal, checkpoints, keys
│   ├── github/                    # GraphQL/REST client, search pacer, quota governor, etags
│   ├── signals/                   # scorecard, deps.dev, osv, brew, krew, artifacthub adapters
│   ├── analyze/                   # rule classifiers + signal fusion + LLM fallback
│   ├── search/                    # Meilisearch client, index defs, settings, task helpers
│   └── query/                     # read-side retrieval shared by portal, REST, MCP, chat
├── infra/                         # compose (dev), Dockerfiles, deploy manifests
└── docs/                          # ADRs, taxonomy rationale, design + implementation plans
```

pnpm workspaces (no Turborepo), TypeScript, ESM, `strict: true`, Node 24, pnpm 11.

**Three deployables, two of them static.** `apps/web` and `apps/backoffice` build to `dist/`;
`apps/api` serves both with `@fastify/static` (portal at `/`, backoffice at `/admin`) alongside
its JSON routes. One Node process in production, next to Meilisearch and the worker container.

**Import boundaries, enforced by lint** (`eslint.config.mjs` — each rule encodes one line of the
CQRS contract; if you need to relax one, re-read §2 first):

- `packages/query` may import `@keco/search` (read) — never `@keco/cache`, `@keco/github`,
  `@keco/signals` or `@keco/analyze`.
- `apps/workers` may import `@keco/cache`, `@keco/github`, `@keco/signals`, `@keco/analyze`;
  only the projector may import `@keco/search` with a write key.
- `@keco/signals` may only be imported by the analyzer, and every adapter in it must go through
  `@keco/cache` — a signal provider called without the cache in front of it is a bug.
- `apps/api` may import `@keco/query`, `@keco/core`, `@keco/cache` (read, by key) and
  `@keco/search` (for enqueue-side checkpoint writes only) — never `@keco/github`,
  `@keco/signals` or `@keco/analyze`.
- `apps/web` and `apps/backoffice` are **browser bundles**: they may import `@keco/core` (types
  and taxonomy) and `meilisearch` only. Any import of `@keco/cache`, `@keco/github`,
  `@keco/signals`, `@keco/analyze` or `node:*` from a frontend is a build-time bug and a
  potential secret leak — the bundle ships to strangers.
- **`apps/web/prerender` is not bundle code.** It is a Node build step that reads the read
  model and writes files, so it may import `@keco/query`. It may not touch the write side, and
  lint scopes the browser rule to `apps/web/src` for exactly this reason.

## 8. Commands

Every dev script is a **mise task** — `mise.toml` is the single entry point, and nothing is
invoked ad-hoc. `mise tasks` lists them all; the table below is the map, not the source of truth.

| Command | What it does |
|---|---|
| `mise run setup` | First run: `.env`, dependencies, Meilisearch, index settings, browser search key |
| `mise run dev` | Portal (`:5173`, HMR) and API (`:3000`) together — `apps/backoffice` doesn't exist yet, so this is the two deployables that do (§0, §7) |
| `mise run web` / `mise run api` | Either half of `dev` alone |
| `mise run web:mock` | Portal alone on `:5173` against the in-browser mock backend — fabricated data, **dev and test only**, provably absent from production builds (§14) |
| `mise run build` | Build the portal, prerender its top tool pages, typecheck the API |
| `mise run prerender` | Emit static tool pages, `sitemap.xml` and `robots.txt` from the read model (§9) — `build` already runs this after `vite build`; run it alone to re-prerender without a fresh bundle |
| `mise run discovery -- --query kubernetes --fresh` | Enumerate repos into `discovery/*.yaml` (resumes by default) |
| `mise run crawler -- --seed cncf,krew --limit 200` | Fetch discovered + seeded repos into the cache |
| `mise run analyzer` | Classify everything with a changed `content_hash` or an expired signal TTL |
| `mise run analyzer -- --force-refresh scorecard` | Ignore TTL for one provider |
| `mise run projector` | Project analyses into Meilisearch |
| `mise run rebuild` | Full offline replay → new index → alias swap, zero GitHub calls |
| `mise run replay -- --consumer analyzer` | Reset a checkpoint |
| `mise run pipeline` | crawl → analyze → project, end to end, on a small seeded set |
| `mise run search:settings` | Apply index settings (idempotent) |
| `mise run search:key` | Mint or fetch the browser's search-only Meilisearch key and write it into `.env` (§12) — idempotent, never overwrites a value already set |
| `mise run admin:hash -- --password '…'` | Hash a password into `ADMIN_PASSWORD_HASH` (§12) |
| `mise run taxonomy:check` | Validate `taxonomy.yaml` — schema, duplicates, `unknown` defaults |
| `mise run check` / `lint` / `test` | `tsc --noEmit` · eslint (incl. §7 boundaries) · vitest |
| `mise run e2e` | Portal end-to-end tests — Playwright drives the real SPA against the in-browser mock backend, so no Meilisearch, no `apps/api` and no token (§9). Not part of `ci`: it needs a browser download, which `e2e:install` does once |
| `mise run format` | prettier |
| `mise run ci` | check + lint + test + taxonomy:check — the gate for §15 |
| `mise run engine -- --help` | The read-model CLI (`apps/workers/src/engine`, commander): `index create` and `seed`. Every command takes `--host` and `--index` |
| `mise run engine:index` | `engine index create` — bootstrap an index with the real `tools` settings. **Safe on production**: it applies settings only to an index that is missing or empty, and refuses to reindex a populated one without `--force-settings` (§5) |
| `mise run engine:seed` | `engine seed` — validate `infra/mock/corpus.json` and upsert it. Fabricated data: it refuses a non-local host without `--force` (§14) |
| `mise run mock` / `mock:corpus` | The local search sandbox (`engine:index` + `engine:seed --clear`) · re-emit the corpus JSON from `apps/web/src/mocks/corpus`, the only seam the two sides share (§7) |
| `mise run infra:up` / `infra:down` / `infra:reset` | Meilisearch (the only local service) |

`package.json`'s own `scripts` exist only so `pnpm <script>` works from muscle memory; each one
delegates straight to the matching mise task rather than re-implementing it, so there is exactly
one definition of what `dev` or `build` means.

Wiping the write model is `rm -rf .cache`; it is rebuilt by a crawl. Wiping the read model is
`mise run infra:reset`; it is rebuilt by `mise run rebuild`, offline.

Always run `mise run ci` before declaring work done.

## 9. Portal (`apps/web`) — static SPA

Vite + React, no SSR, no framework routing conventions. The build output is a `dist/` folder
served by `apps/api`. `react-router` for client navigation.

**Search is browser → Meilisearch, directly.** `meilisearch-js` with the search-only key, ~80 ms
debounce, no backend round-trip per keystroke — that is the whole reason the search key is
public. State is **URL-synced** (`?q=&kind=&domain=&install=&sort=&view=`) so results are
shareable and back/forward work; list/grid toggle; facet counts from Meilisearch; keyboard
navigable (`/` focuses, arrows move, enter opens). Empty and zero-result states must suggest
something useful. Hybrid queries (`hybrid: { embedder }`) land with v2.

**Theme.** Light by default, dark by `prefers-color-scheme`, overridable by a header toggle that
persists to `localStorage`. Tokens live in `apps/web/src/styles/theme.css` and reach Tailwind
through `@theme inline`; a token defined any other way cannot follow the theme, and one omitted
from that block generates no utility at all. **The shell is now part of the prerender contract:**
an inline, blocking script in `index.html` marked `keco-theme-bootstrap` stamps `data-theme`
before first paint, and `prerender/html.ts` asserts the built shell still contains it — alongside
its existing assertions on `<title>`, the meta description and `<div id="root">`. The script
stamps the attribute *only* for an explicit stored choice, which is why `@custom-variant dark`
carries both an attribute branch and a media-query branch; the two are a matched pair, and
changing one without the other half-applies dark mode. Colour encodes **state, not category** —
accent means "selected", `StatusPill`'s green/amber/red means a real state and always ships an
icon plus a word, and health is a single-hue magnitude ramp with the number beside it. Painting a
repo red because a provider never scanned it is §4.4's bias made visible, so the palette forbids
it structurally. See `apps/web/README.md` for the mechanism.

**Home** — a hero search field, then **Browse**: one chip row per facetable taxonomy family
(`facetableFamilies()` — currently all eight), built from the `tools` facet distribution fetched
at `hitsPerPage: 0` so the page pays for facet counts and nothing else. A value with zero
documents renders no chip, so the row renders nothing until the first crawl fills the index — no
dead links, no wall of zero-count chips. Each chip links to `/search?<param>=<value>` using the
family's declared `param`. Below Browse, **Highest momentum** — the top results from `whatsHot()`,
labelled "momentum" per §4.4, never "trending".

**Tool page** — `/tools/{owner}/{repo}`. Sidebar: stars, forks, language, license, last commit,
latest release, score breakdown with `quality_coverage`, canonical repo link. Install block: one
tab per verified method, copy button, proof link. **Related**: same `kind` + overlapping
`domains`, ranked by score, excluding the same owner. **Who is using it**: only adopters with an
`evidence_url` — no invented logos; hide the section when there's nothing real. Always show
owner, license, and "data from GitHub, updated `<indexed_at>`".

**The README comes from the cache, never from the index** — and the browser cannot read the
cache, so it comes through `apps/api`: `GET /api/readme/{owner}/{repo}` reads the cached
markdown by key and returns **sanitised** HTML (rehype-sanitize), with relative image and link
URLs rewritten against `image_base_url`, the top badge-only paragraph stripped, and Shiki
highlighting applied server-side. Rendering untrusted README markdown in the browser without
that server-side sanitise step is a stored-XSS hole across the whole corpus.

**The icon comes the same way, and for the same reason.** `GET /api/icon/{owner}/{repo}/{32|64|160}.png`
serves a PNG the crawler rasterised from the verbatim `icon.src`, so nothing active from a
stranger's SVG ever reaches a reader — the rasterise *is* the sanitise, with `nosniff` and a
`default-src 'none'` CSP behind it. The document's `icon` descriptor says whether one exists,
so an iconless repo renders a deterministic monogram tile and fires no request at all. The
monogram's hue is decorative and derived from the repo name: it encodes no state, which is
what keeps it clear of the colour rule above.

### SEO without SSR

Dropping Next.js drops server rendering, and a bare SPA is not indexable enough for a search
portal whose acquisition channel is organic search. The replacement is **build-time prerender**,
and it is not optional:

- A build step queries `tools` for the top N (~1000) by `score_total` and emits a real static
  HTML file per tool page — `<h1>`, `<title>`, meta description, JSON-LD `SoftwareApplication`,
  and the tool's `readme_excerpt` as indexable prose. It renders the *same* React route tree
  the browser mounts (`renderToString` under a static router), so what a crawler sees and what
  a reader sees cannot drift. Fastify serves that file when the build manifest lists the path
  and falls back to `index.html` otherwise; the SPA hydrates over it either way.
- **The full README is not inlined.** The markdown pipeline lives in `apps/api`, so the
  prerender stays a pure read-model consumer with no cache access and no second copy of the
  renderer. `readme_excerpt` (~1.5 KB, already in the document) is what a crawler indexes; the
  full sanitised README arrives client-side from `/api/readme/{owner}/{repo}`. This is a
  deliberate reduction of the SEO surface — if organic traffic shows it was the wrong trade,
  the fix is a shared renderer package, recorded as an ADR.
- `sitemap.xml` and `robots.txt` are generated in the same step, from the same query.
- The prerender reads the read model **at build time only**. It is not a server renderer, and
  no request path may acquire one.
- Prerendered HTML is as stale as the last build. Rebuild on the same cadence as the projector's
  full rebuild, and keep `indexed_at` visible so the staleness is honest.
- `/admin` is `noindex` and never prerendered.

If a change makes the top tool pages non-prerenderable, it has broken the SEO surface — treat
that as a blocking regression, not a follow-up.

**The portal has end-to-end coverage, and it runs with no backend at all.** `mise run e2e`
starts Vite with the §14 mock backend and drives every route through Chromium: home, search
(facets, sort, view, paging, the whole keyboard contract), the zero-result state and its
*verified* suggestions, the tool page (install tabs, clipboard, README, related, archived), the
404, and the theme's stored-choice-vs-OS asymmetry. It is deliberately not in `mise run ci` —
it needs a browser binary — and it deliberately cannot run against a production build, because
the mock is eliminated from one by design. The prerendered HTML is therefore *not* what it
tests; `prerender/ssr.test.ts` and `mise run build` own that.

**That coverage is a floor, not a snapshot.** Every route, control and state a reader can reach
carries an e2e test, and anything added here adds one in the same change — §13 makes it a
requirement of the spec and §15 a condition of done. A portal change with no e2e test is the
same omission as a classification rule with no fixture.

## 10. Backoffice (`apps/backoffice`) — observe and command, never edit

Vite + React static SPA, same build/serve shape as the portal, mounted at `/admin`.

There is no curation, so the backoffice has exactly two jobs: **show what the pipeline did**, and
**issue commands**.

1. **Pipeline health** — from `repos_state`: counts by phase, repos failing, repos skipped and
   why, classification confidence distribution, GitHub quota remaining, checkpoint lag per
   consumer (the number that tells you whether the system is keeping up).
2. **Repo inspector** — cached `repo.json`, README, tree, the analysis document with its rules
   trace or LLM output, and the projected `tools` document side by side, served read-only by
   `apps/api`. When something is misclassified, this screen shows exactly which stage got it
   wrong.
3. **Commands** — buttons that append an event or reset a checkpoint: re-crawl this repo,
   re-analyze this repo, re-analyze everything with `confidence < 0.7`, rebuild the index,
   promote/rollback an alias. They enqueue and return immediately; they never do the work in
   the request.
4. **Taxonomy** — vocabulary with corpus facet counts. A category with 3 or 4000 tools is a
   taxonomy bug.
5. **Chat traces** (v2) — weak-retrieval queries, to drive eval fixtures.

**There is no "edit this field" form, and adding one is out of scope.** The upstream architecture
notes sketched a classification-correction UI writing back into the index; that is explicitly
rejected here. A per-repo override is a second source of truth that survives no rebuild and
silently diverges from the analyzer. The fix for a misclassification belongs in the analyzer's
rules, where it improves every similar repo at once — and where a fixture can prove it. That is
the whole reason curation was cut (§1, ROADMAP "Explicitly not planned").

## 11. `apps/api` — REST, MCP, chatbot, commands

Fastify, TypeScript, ESM, JSON-only for its own endpoints, plus `@fastify/static` for the two
SPA bundles. It holds the **only** copy of the Meilisearch master key and the only cache handle
on the read side. Request and response validation is local to each route — `z.object` schemas
in `routes/admin.ts` and `routes/readme.ts` today — not centralised in `@keco/core`; what
`@keco/core` supplies instead is the shared read-side vocabulary both REST and the portal need
(`ToolDocument`, `MAX_TOTAL_HITS`, `isSortKey`, `selectionFromParams`), which is a different
thing from a per-route body schema.

Three machine front doors, **one implementation**: `packages/query` holds all retrieval and
exports `searchTools() · getTool() · compareTools() · findAlternatives() · whatsHot()`. REST,
MCP and chat are thin adapters over it. A capability in one and not the others is a bug.

The portal is the deliberate exception. §9 has it querying Meilisearch from the browser with
the search-only key, and §7 bars a browser bundle from importing `@keco/query`. What the two
sides share is the *algebra* — `buildFilters`, `selectionFromParams`, `defaultFacets`,
`familyAttribute`, the sort specs — which lives in `@keco/core` precisely so both can reach it.
The portal's own client is `apps/web/src/lib/search.ts`, about sixty lines of `.search()` calls
over that shared algebra. Duplicating a filter mapping would drift; duplicating a `.search()`
call cannot.

**REST** — `/api/v1/*`, read-only, anonymous, CORS-open, IP rate-limited. Public identifier is
`owner/repo`; never leak internal ids. *(Aspirational, not yet true: the plan was for responses
to be typed by the same zod schemas that generate the MCP tool shapes. Today `routes/v1.ts`
hand-shapes its response objects and `routes/mcp.ts` is a stub returning plain string
descriptions — see the TODO in that file. Land it when MCP grows past that stub, not before.)*

**MCP** — `/api/mcp`, streamable HTTP, read tools only.

- Tool *descriptions* are the interface — an agent picks from the description alone. Say
  explicitly when not to use each tool.
- Compact structured content: `search_tools` caps at 10 results with ~40-word summaries. A 50 KB
  response burns the caller's context and gets Keco dropped from their toolset.
- Every item carries `url` (Keco page) + `repo_url` so agents can cite, and `indexed_at` so they
  know freshness — eventual consistency must be visible to callers.

**Chatbot** — `/api/chat`, strictly retrieval-grounded:

1. Retrieve first (Meilisearch hybrid: keyword + embeddings), answer only from what came back.
2. Never name a tool outside the retrieved set. Never emit an install command not in that tool's
   verified `install_methods` — the model does not write shell commands from memory.
3. Every recommendation renders as a tool card linking to its Keco page.
4. Weak retrieval ⇒ say so, offer "possibly related", don't pad.
5. Flag archived or stale suggestions.
6. Stateless, no history, no PII, per-IP rate limit, hard token budget per request.
7. Log `(query, retrieved_ids, answer)` to `traces`; evals in `packages/query/evals` with ~50
   real devops questions and expected tools. Retrieval quality you can't measure will rot.

**Commands** — `/api/commands/*`, the only write path in the whole read side, and it writes to
the *write* model: it appends a journal event or resets a checkpoint, then returns. It never
touches Meilisearch and it never does the work inline. A route handler that loops over repos is
always a bug (§14).

**No `POST /log-search`.** The upstream notes proposed logging every query into a `search_logs`
index for a backoffice "top searches" view. It is not in this design: it is a write on the read
path (§2.2), it makes the browser's public key a write vector or forces a round-trip that
defeats search-as-you-type, and it stores user-derived data in a system that otherwise holds
nothing but public GitHub facts. If query analytics become necessary, they arrive as a separate
decision with a retention policy, not as a side effect of search.

## 12. Auth & secrets

- **Backoffice auth is a single admin credential**, not a full auth system: `POST /api/admin/login`
  compares against `ADMIN_PASSWORD_HASH` with a constant-time comparison and sets a signed,
  `HttpOnly`, `SameSite=Strict` session cookie. There is one admin, the backoffice can only read
  and enqueue, and an OAuth provider would be more moving parts than the surface justifies. This
  replaces the Auth.js + GitHub OAuth design that the Next.js layout assumed.
- **Authorize inside every handler**, not only in a plugin hook. A route that trusts an upstream
  guard is one refactor away from being unguarded.
- `/api/commands/*`: admin session **or** `Bearer $COMMAND_TOKEN` compared with
  `timingSafeEqual`, no CORS.
- Meilisearch: master key server-side only, in `apps/api`'s environment. The browser bundles get
  `VITE_MEILI_SEARCH_KEY` — search-only, scoped to `tools`.
- **Vite inlines every `VITE_`-prefixed variable into the bundle at build time.** Anything with
  that prefix is public, permanently, in every deployed artifact. Never prefix a secret; never
  read `process.env` from frontend code expecting it to stay server-side.
- The cache is a local directory today, so `apps/api`'s read-only access is a convention that
  lint rules and code review enforce, not a credential. When object storage lands it becomes a
  read-only credential — write the code as if it already were one.
- `.env.example` stays in sync, with a comment naming the surface that reads each variable.

## 13. Conventions

- Validate every external payload with **zod** at the boundary. `any` is banned (lint error)
  outside verbatim cached GitHub payloads.
- A single bad repo must never abort a run: catch per item, emit `RepoFailed`, continue.
- Structured logging (pino): one debug line per repo, one info summary per batch, checkpoint
  position in every summary. The stderr progress bar falls back to plain lines on a non-TTY —
  don't reintroduce ANSI writes that assume a terminal.
- Tests: unit-test the analyzer against `packages/analyze/fixtures/*.json` — real cached
  payloads, committed. **A new classification rule requires a fixture proving it.** Fixtures are
  literally cache entries, which is the other reason the cache exists.
- **Every `apps/web` change ships end-to-end coverage, and every spec or plan that touches
  `apps/web` names the e2e tests it will add.** A behaviour a reader can reach — a route, a
  control, a state, a keyboard path — is not delivered until a Playwright test drives it in a
  browser. Unit tests cover `src/lib/**`, which is where the logic lives on purpose; they do
  not cover what happens when the logic meets a DOM, a URL and a focus ring, and that gap is
  where this app's real bugs have been. Coverage is a first-class requirement here, not a
  follow-up ticket: `mise run e2e` needs no Meilisearch, no `apps/api` and no token (§9), so
  "there was no environment to test in" is never the reason one is missing.
- A spec that adds a page, a control or a state and lists no e2e test is incomplete — send it
  back rather than implementing it and promising tests later. The same rule as the analyzer's:
  a new rule requires a fixture proving it, and new portal behaviour requires a test driving
  it.
- Design and implementation plans live in `docs/`; ADRs in `docs/adr/`. A decision that reverses
  one of these gets an ADR, not a silent edit.
- Conventional Commits scoped by package: `feat(analyzer): …`, `fix(projector): …`.

## 14. Things that will bite you

**CQRS and the pipeline**

- **Reading a read model from the write side.** The tempting shortcut is "let the analyzer query
  Meilisearch for repos needing work". Don't — checkpoints and the journal exist for this, and
  the coupling is very hard to unwind later.
- **Listing the cache to find work** is slow now and billed per request once it is object
  storage; read the journal.
- **Assuming the cache is a filesystem.** `fs.readFile` on a cache path, a glob, a `path.join`
  outside `packages/cache` — each one is a line that has to be found and undone when the S3
  adapter lands. Go through the `Storage` port.
- **A third-party call without the cache in front of it** turns a replay into a 30k-request
  storm and gets your IP throttled by Scorecard or Artifact Hub. Every provider goes through
  `external/`.
- **Signal freshness drifts from repo freshness**: a repo unchanged for a year still needs its
  Scorecard refreshed weekly. Analysis is triggered by `content_hash` change *or* by the oldest
  signal's TTL expiring — not by `content_hash` alone.

**GitHub**

- **The analyzer's GitHub calls come out of the crawler's quota** (`GITHUB_QUOTA_CRAWLER_SHARE`).
  Budget them explicitly or use a second token, or a busy analyzer starves the crawler.
- **Search and core REST have separate, very different limits.** ~30 req/min for Search vs 5000
  points/hour for core. Discovery has its own pacer for exactly this reason; don't route
  discovery calls through the core client.
- The 5000 points/hour budget is shared by all shards. Don't parallelise past the configured
  concurrency; give each shard its own token or divide the budget in config.
- **Scorecard coverage is partial** — OpenSSF only scans its weekly cron set, so most niche
  repos have no score. Absence must renormalise the quality axis, never score as zero.

**Meilisearch**

- **Writes are async** — advance the checkpoint only after `waitForTask`, or a crash loses a
  batch silently.
- **Partial updates are a shallow merge** — whole sub-objects only.
- **Deep pagination is capped** by `pagination.maxTotalHits`; admin listing uses `getDocuments`.

**Frontend and API**

- **`VITE_`-prefixed variables are baked into the shipped bundle.** A secret with that prefix is
  a published secret, and rotating it means rebuilding and redeploying.
- **The mock backend is development and test only** (`apps/web/src/mocks`, `mise run web:mock`).
  It serves fabricated repos, scores and `install_methods` — shipping it would put invented
  `brew install` lines in front of real readers, which §6 names as the worst bug this project
  can ship. Five layers keep it out: the `import.meta.env.DEV` guard in `main.tsx`, `msw` as a
  `devDependency`, a lint rule barring `src/mocks/**` imports outside `main.tsx` and tests, a
  `dist/` scan wired into `mise run build`, and the generated worker script being gitignored.
  That last one only covers a clean checkout, CI and deployments — `vite build` copies `public/`
  into `dist/` verbatim no matter what, so a machine that has run `mise run web:mock` keeps
  regenerating the file locally; `mise run build` deletes it before building for exactly that
  reason, and the `dist/` scan is what actually verifies the invariant either way. Adding a
  production path to the mock reverses a recorded decision and needs an ADR.
- **The SPA has no server.** A deep link like `/tools/argoproj/argo-cd` only resolves because
  Fastify falls back to `index.html` (or to a prerendered file). Add a route in the client and
  you must confirm the server fallback still covers it, or the URL 404s on hard refresh.
- **SEO is prerender-only now.** A change that makes the tool page depend on runtime-only data
  removes it from the index. See §9.
- **README markdown is untrusted input.** Sanitise server-side in `apps/api`, never
  `dangerouslySetInnerHTML` on raw markdown output in the browser.
- README relative image paths break unless rewritten — test with `kubernetes/kubectl`.
- **Long work cannot run inside a request handler** (timeouts, and Fastify has no background
  runtime). Handlers enqueue; workers execute. A `for` loop over 10k repos in `apps/api` is
  always a bug.
- Static assets and JSON routes share one Fastify instance: register `@fastify/static` so it
  cannot shadow `/api/*`, and keep the SPA fallback last.

**Corpus quality**

- Plenty of repos mention Kubernetes without being ecosystem tools (courses, blogs, dotfiles).
  `k8s_relevance` demotes them: keep them in cache, filter them out at projection time.
- Homebrew formula names rarely match repo names (`ahmetb/kubectx` → `kubectx`). Verify against
  the Homebrew API, and cache that API response.

## 15. Definition of done

1. `mise run ci` green — check, lint, test, taxonomy:check.
2. Analyzer changes: re-run over the fixture set, diff the classification output, no unexplained
   regressions. New signal provider ⇒ cached adapter, TTL, timeout, null-path tested.
3. Read-model changes: applied by re-projecting from cache — **no network calls at all** — and
   promoted by alias swap, never in place.
4. API changes: contract updated in `@keco/core`, REST + MCP both reflect it.
5. Portal changes: `mise run e2e` green, **including a test for the behaviour just added or
   changed** — a page, a control, a state or a keyboard path without one is not done (§13). The
   tool page still prerenders with a real `<h1>`, metadata and JSON-LD; search is
   keyboard-navigable; no `VITE_`-prefixed secret entered the bundle.
6. Nothing on the read side writes a read model; nothing on the write side reads one.
7. Update this file when a contract changes; `docs/` when the taxonomy changes; `docs/adr/` when
   a decision here is reversed.
