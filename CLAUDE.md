# AGENTS.md — Keco

Instructions for AI coding agents working in this repository. Read this fully before touching
code.

## 1. What Keco is

Keco is a search portal for the **Kubernetes ecosystem**. Everything it shows is derived from
public GitHub data: crawlers pull repositories into a raw cache, analyzers classify and score
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

Everything is reproducible from GitHub. Nothing in this system is precious.

## Workflow developper

Use mise to install tools, runtime.

All dev scripts and tasks must run from mise task.

The roadmap — what is done, what is next, and what is deliberately not planned — is
[ROADMAP.md](./ROADMAP.md). Check it before proposing work: several obvious-looking gaps
(object storage, curation, star history) are decisions, not omissions.

## 2. CQRS — the organising principle

**Read this before writing any code. Every design question is answered by it.**

```
        ┌──────────────── WRITE SIDE (commands) ────────────────┐
        │                                                       │
 GitHub │  crawler ──▶ CACHE ──▶ analyzer ──▶ CACHE ──▶ projector│
  API   │  (fetch)    (raw)     (classify)   (analysis)  (build) │
        │                 └── journal of events ──┘              │
        └───────────────────────────┬───────────────────────────┘
                                    │ project
        ┌───────────────────────────▼───────────────────────────┐
        │  READ MODELS — Meilisearch                            │
        │  `tools` (public)   `repos_state` (admin)  `traces`   │
        └───────────────────────────┬───────────────────────────┘
                                    │ query only
              portal · REST API · MCP · chatbot · backoffice
```

The rules, in priority order:

1. **The write side never reads a read model.** An analyzer that queries Meilisearch to decide
   what to work on has broken the pattern — it uses the journal and its own checkpoint. This is
   the mistake to watch for; it is subtle and it couples everything back together.
2. **The read side never writes.** No page, API route or MCP tool mutates anything. If a read
   path needs to write, the design is wrong.
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

**There is exactly one adapter today — the filesystem.** Object storage (R2/S3) is a v2 item
and slots in behind the same port when a deployment needs it; see ROADMAP.md. Do not add an S3
client "for later", and do not write code that assumes either backend: everything goes through
`Storage`, so the swap must be a one-file change with no caller touched. A relative `CACHE_DIR`
resolves against the workspace root, not the process's cwd, so every worker and the web app
share one cache.

```
cache/
├── repos/{owner}/{repo}/
│   ├── repo.json           # GitHub repo API response, verbatim
│   ├── readme.md           # raw markdown, verbatim
│   ├── readme.json         # { path, branch, etag, image_base_url }
│   ├── tree.json           # file tree (paths only, truncated flag)
│   ├── releases.json       # latest N releases
│   ├── manifests/          # go.mod, Chart.yaml, package.json, Cargo.toml… when present
│   └── _fetch.json         # { etags, fetched_at, content_hash, source }
├── external/{provider}/{key}.json   # every third-party response + { fetched_at, ttl, status }
├── analysis/{owner}/{repo}.json     # analyzer output, schema-validated
├── journal/{YYYY-MM-DD}/{ulid}.json # append-only events
└── checkpoints/{consumer}.json      # { last_event_id, updated_at }
```

- **Verbatim means verbatim.** Never transform on write. Parsing happens downstream, so a
  parser bug is fixed by re-analyzing, not re-crawling.
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

Three independent processes. **They never talk to each other.** Each is a loop: read events
from its checkpoint → do work → write cache → append events → advance checkpoint.

| Worker | Consumes | Produces | Network | Cadence |
|---|---|---|---|---|
| **crawler** | seed lists, `RepoDiscovered` | `repos/**`, `RepoFetched` | GitHub (rate-limited) | continuous, full sweep weekly |
| **analyzer** | `RepoFetched` where `changed` | `analysis/**`, `RepoAnalyzed` | signal providers + LLM, **all cached** | continuous |
| **projector** | `RepoAnalyzed` | Meilisearch `tools`, `repos_state` | none | continuous, batched |

Consequences that matter:

- The analyzer **may** call the network — Scorecard, deps.dev, registries, GitHub for signals
  the crawler didn't collect. But every call goes through the TTL cache in `external/`, so a
  *replay* is nearly free: rule changes, prompt changes and taxonomy changes can be re-run over
  the whole corpus without a network storm. Keep that property; it's what makes the pipeline
  cheap to iterate on.
- The projector is pure: cache in, index out, no network. It must stay that way — it is the
  thing you re-run most often.
- The projector is the only writer to Meilisearch. Nothing else writes to it, ever.
- Scale out by **deterministic sharding** (`hash(repo) % SHARD_COUNT == SHARD_INDEX`), not by
  locks or leases. There is no coordination primitive here and you must not invent one.
- Every worker is safe to kill at any moment. Crash mid-batch ⇒ checkpoint not advanced ⇒
  reprocess ⇒ same result. If a worker isn't crash-safe, it's wrong.

### 4.1 crawler
GitHub Search returns **at most 1000 results per query**, ~30 authenticated req/min. So
discovery is sharded *and* seeded:

- Shard `topic:kubernetes`, `topic:k8s`, `topic:kubernetes-operator`, `topic:kubectl-plugin`,
  `topic:helm-charts`, `kubernetes in:name,description,readme` by `stars:` ranges (`>5000`,
  `1000..5000`, `500..999`, …) and `created:` year windows so each shard stays under 1000 hits.
- Seed from registries — higher signal than keyword search: CNCF landscape (`cncf/landscape`),
  krew index (`kubernetes-sigs/krew-index` → `plugins/*.yaml`), Artifact Hub API,
  OperatorHub / `k8s-operatorhub/community-operators`, curated `awesome-*` lists.
- GraphQL for bulk metadata (≤100 repos/query — far cheaper against the 5000 points/hour
  budget); REST only for README, tree, releases.
- `ETag` / `If-None-Match` on everything: a 304 costs no quota and short-circuits to
  `RepoFetched{changed:false}`.
- Honour `x-ratelimit-remaining`, exponential backoff on 403/429, respect `retry-after`. A
  crawl that gets the token throttled is a failed crawl.
- Skip: forks (unless > 200 stars and diverged), archived + stale > 24 months (unless > 1000
  stars), repos whose only Kubernetes link is a CI manifest. Emit `RepoSkipped` with a reason —
  never drop silently.

### 4.2 analyzer — rules first, external signals, AI as fallback
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
- **GitHub calls here share the crawler's 5000 points/hour.** Split the budget explicitly in
  config (e.g. 80 % crawler / 20 % analyzer) or use a separate token. Two components spending
  the same quota without a contract is how crawls start failing at 3am.
- Record every provider's `fetched_at` in the analysis document. A score you can't date is a
  score you can't defend.

#### Pass 3 — LLM fallback
Only when confidence < 0.7 or `kind` is ambiguous: README first 8 KB + topics + tree + the
signals from pass 2, requiring **structured output validated by `AnalysisSchema`**. Invalid →
retry once → fall back to `kind: 'service'`, `confidence: 0.3`, `needs_review: true`. Free text
never leaves the analyzer.

Every analysis document records `method` (`rules` | `signals` | `llm`), `model`, `content_hash`,
`signals_used[]` and `partial_signals[]` — so any classification can be explained, dated and
reproduced.

### 4.3 projector
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
  `topics`, `readme_excerpt`.
- `filterableAttributes`: `kind`, `domains`, `install_methods`, `language`, `license`,
  `archived`, `stars`, `has_release`, `k8s_relevance`, `has_scorecard`.
- `sortableAttributes`: `stars`, `score_total`, `score_momentum`, `pushed_at`.
- Default ranking rules + `score_total:desc` appended — relevance first, health as tie-breaker.
- `pagination.maxTotalHits` raised deliberately (default 1000 caps deep paging).
- Embedder configured here for hybrid search (v2).

### Document shape
```ts
{
  id, owner, name, full_name, description, homepage, repo_url,
  stars, forks, open_issues, language, license, topics[], archived,
  pushed_at, created_at, discovery_source,
  summary, kind, domains[], k8s_relevance, confidence, needs_review,
  install_methods: [{ method, command, source_url, verified_at }],
  score: { popularity, activity, adoption, quality, quality_coverage, total, momentum },
  signals: { scorecard: { score, checks, fetched_at } | null,
             osv: { open_vulns } | null, dependents: number | null },
  readme_excerpt,              // ~1.5 KB — the full README comes from the cache
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
- **The client key is search-only and scoped to `tools`.** Never issue a browser key with access
  to `repos_state` or `traces`.

## 6. Taxonomy — two axes, never one

`packages/core/src/taxonomy.ts`. Closed vocabulary; adding a value is a deliberate PR with
rationale in `docs/taxonomy.md`, not an ad-hoc string.

**`kind`** — what the artifact *is* (exactly one):
`cli` · `kubectl-plugin` · `operator` · `controller` · `helm-chart` · `crd-library` ·
`admission-webhook` · `distribution` · `dashboard-ui` · `library-sdk` · `terraform-provider` ·
`ide-extension` · `service` · `learning-resource`

**`domains`** — what problem it solves (1–3):
`networking` · `security` · `policy` · `storage` · `observability` · `ci-cd` · `gitops` ·
`packaging` · `autoscaling` · `cost` · `multi-cluster` · `backup-dr` · `service-mesh` ·
`dev-experience` · `testing` · `ai-ml` · `edge` · `troubleshooting`

**`install_methods`** — detected, never guessed: `brew` · `mise` · `asdf` · `krew` · `helm` ·
`kubectl-apply` · `go-install` · `cargo` · `npm` · `pip` · `nix` · `arkade` · `apt` ·
`container-image` · `curl-script` · `github-release` · `operator-hub`

Each carries a **verified command** (`brew install k9s`) and a `source_url` proving the entry
exists in that registry. Unprovable ⇒ not listed. Rendering a `brew install` line for a formula
that doesn't exist is the single worst bug this project can ship — people paste these into a
terminal.

## 7. Repository layout

```
keco/
├── apps/
│   ├── web/                       # Next.js 16, App Router — read side only
│   │   └── src/app/
│   │       ├── (portal)/          # /, /search, /tools/[owner]/[repo], /c/[slug]
│   │       ├── (admin)/admin/     # observability + command triggers
│   │       └── api/
│   │           ├── v1/            # public REST (anonymous, rate-limited, CORS *)
│   │           ├── mcp/           # MCP streamable HTTP
│   │           ├── chat/          # RAG chatbot (v2)
│   │           └── commands/      # enqueue-only: recrawl, reanalyze, reproject (token)
│   └── workers/
│       └── src/{crawler,analyzer,projector}/
├── packages/
│   ├── core/                      # zod schemas, taxonomy, scoring, event types
│   ├── cache/                     # Storage port + fs adapter, journal, checkpoints
│   ├── github/                    # GraphQL/REST client, shared quota governor, etags
│   ├── signals/                   # scorecard, deps.dev, osv, brew, krew, artifacthub adapters
│   ├── analyze/                   # rule classifiers + signal fusion + LLM fallback
│   ├── search/                    # Meilisearch client, index defs, settings, task helpers
│   └── query/                     # read-side retrieval shared by portal, REST, MCP, chat
├── infra/                         # compose (dev), Dockerfiles, deploy manifests
└── docs/                          # ADRs, taxonomy rationale
```

pnpm workspaces, TypeScript, ESM, `strict: true`.

**Import boundaries, enforced by lint:**
- `packages/query` may import `@keco/search` (read) — never `@keco/cache` or `@keco/github`.
- `apps/workers` may import `@keco/cache`, `@keco/github`, `@keco/signals`, `@keco/analyze`;
  only the projector may import `@keco/search` with a write key.
- `@keco/signals` may only be imported by the analyzer, and every adapter in it must go through
  `@keco/cache` — a signal provider called without the cache in front of it is a bug.
- `apps/web` may **not** import `@keco/github`, `@keco/signals` or `@keco/analyze`. The web app
  never fetches from third parties.

## 8. Commands

Every dev script is a **mise task** — `mise.toml` is the single entry point, and nothing is
invoked ad-hoc. `mise tasks` lists them all.

| Command | What it does |
|---|---|
| `mise run setup` | First run: `.env`, dependencies, Meilisearch, index settings |
| `mise run dev` | Next.js on :3000 |
| `mise run crawler -- --seed cncf,krew --limit 200` | Discover + fetch into cache |
| `mise run analyzer` | Classify everything with a changed `content_hash` or an expired signal TTL |
| `mise run analyzer -- --force-refresh scorecard` | Ignore TTL for one provider |
| `mise run projector` | Project analyses into Meilisearch |
| `mise run rebuild` | Full replay → new index → alias swap |
| `mise run replay -- --consumer analyzer` | Reset a checkpoint |
| `mise run pipeline` | crawl → analyze → project, end to end |
| `mise run search:settings` | Apply index settings (idempotent) |
| `mise run check` / `lint` / `test` | `tsc --noEmit` · eslint (incl. §7 boundaries) · vitest |
| `mise run ci` | All three — the gate for §15 |
| `mise run infra:up` / `infra:down` / `infra:reset` | Meilisearch (the only local service) |

Wiping the write model is `rm -rf .cache`; it is rebuilt by a crawl.

Always run `mise run ci` before declaring work done.

## 9. Portal (read side)

**Search** — client component querying Meilisearch directly, debounced, **URL-synced state**
(`?q=&kind=&domain=&install=&sort=&view=`) so results are shareable and back/forward work;
list/grid toggle; facet counts from Meili; keyboard navigable (`/` focuses, arrows move, enter
opens). Empty and zero-result states must suggest something useful.

**Tool page** — RSC + ISR (`revalidate = 3600`), `generateStaticParams` for the top 1000 by
score. The SEO surface: real `<h1>`, metadata, JSON-LD `SoftwareApplication`, `sitemap.ts`
generated from the index. The **README is read from the cache**, not the index, and rendered
server-side: **sanitise the HTML** (rehype-sanitize), rewrite relative image/link URLs against
`image_base_url`, strip the top badge-only paragraph, highlight with Shiki. Sidebar: stars,
forks, language, license, last commit, latest release, score breakdown, canonical repo link.
Install block: one tab per verified method, copy button, proof link. **Related**: same `kind` +
overlapping `domains`, ranked by score, excluding the same owner. **Who is using it**: only
adopters extracted from the cached README/ADOPTERS.md with an `evidence_url` — no invented
logos; hide the section when there's nothing real. Always show owner, license, and "data from
GitHub, updated <indexed_at>".

Reading the cache from the web app is the one place the read side touches write-side storage —
it is a **read**, by key, of an immutable blob. Never write, never list.

`/` → RSC, `revalidate = 900`. `(admin)/*` → `force-dynamic`, `noindex`.

## 10. Backoffice — observe and command, never edit

There is no curation, so the backoffice has exactly two jobs: **show what the pipeline did**,
and **issue commands**.

1. **Pipeline health** — from `repos_state`: counts by phase, repos failing, repos skipped and
   why, classification confidence distribution, GitHub quota remaining, checkpoint lag per
   consumer (the number that tells you whether the system is keeping up).
2. **Repo inspector** — cached `repo.json`, README, tree, the analysis document with its rules
   trace or LLM output, and the projected `tools` document side by side. When something is
   misclassified, this screen shows exactly which stage got it wrong.
3. **Commands** — buttons that append an event or reset a checkpoint: re-crawl this repo,
   re-analyze this repo, re-analyze everything with `confidence < 0.7`, rebuild the index,
   promote/rollback an alias. They enqueue and return immediately; they never do the work in
   the request.
4. **Taxonomy** — vocabulary with corpus facet counts. A category with 3 or 4000 tools is a
   taxonomy bug.
5. **Chat traces** (v2) — weak-retrieval queries, to drive eval fixtures.

If you find yourself adding an "edit this field" form, stop: the fix belongs in the analyzer's
rules, where it improves every repo instead of one. That is the whole reason curation was cut.

## 11. Machine surfaces — REST, MCP, chatbot

Three front doors, **one implementation**: `packages/query` holds all retrieval and exports
`searchTools() · getTool() · compareTools() · findAlternatives() · whatsHot()`. REST, MCP and
chat are thin adapters; the portal uses the same functions server-side. A capability in one and
not the others is a bug.

**REST** — `/api/v1/*`, read-only, anonymous, CORS-open, IP rate-limited, responses typed by zod
schemas in `@keco/core` (the same ones that generate MCP tool shapes). Public identifier is
`owner/repo`; never leak internal ids.

**MCP** — `/api/mcp`, streamable HTTP, Node runtime, read tools only.
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

## 12. Auth & secrets

- Backoffice: Auth.js, GitHub OAuth, allowlist in `ADMIN_LOGINS`. Guard `(admin)` in middleware
  **and** re-check inside every server action — middleware alone is not authorization.
- `/api/commands/*`: admin session **or** `Bearer $COMMAND_TOKEN`, `timingSafeEqual`, no CORS.
- Meilisearch: master key server-side only. `NEXT_PUBLIC_MEILI_SEARCH_KEY` is search-only,
  scoped to `tools`.
- The cache is a local directory today, so the web app's read-only access is a convention the
  lint rules and code review enforce, not a credential. When object storage lands, it becomes a
  read-only credential — write the code as if it already were one.
- `.env.example` stays in sync, with a comment naming the surface that uses each variable.

## 13. Conventions

- Validate every external payload with **zod** at the boundary. `any` is banned outside verbatim
  cached GitHub payloads.
- A single bad repo must never abort a run: catch per item, emit `RepoFailed`, continue.
- Structured logging (pino): one debug line per repo, one info summary per batch, checkpoint
  position in every summary.
- Tests: unit-test the analyzer against `packages/analyze/fixtures/*.json` — real cached
  payloads, committed. **A new classification rule requires a fixture proving it.** Fixtures are
  literally cache entries, which is the other reason the cache exists.
- Conventional Commits scoped by package: `feat(analyzer): …`, `fix(projector): …`.

## 14. Things that will bite you

- **Reading a read model from the write side.** The tempting shortcut is "let the analyzer query
  Meilisearch for repos needing work". Don't — checkpoints and the journal exist for this, and
  the coupling is very hard to unwind later.
- **Meilisearch writes are async** — advance the checkpoint only after `waitForTask`, or a crash
  loses a batch silently.
- **Partial updates are a shallow merge** — whole sub-objects only.
- **Listing the cache to find work** is slow now and billed per request once it is object
  storage; read the journal.
- **Assuming the cache is a filesystem.** `fs.readFile` on a cache path, a glob, a `path.join`
  outside `packages/cache` — each one is a line that has to be found and undone when the S3
  adapter lands. Go through the `Storage` port.
- **A third-party call without the cache in front of it** turns a replay into a 30k-request
  storm and gets your IP throttled by Scorecard or Artifact Hub. Every provider goes through
  `external/`.
- **Scorecard coverage is partial** — OpenSSF only scans its weekly cron set, so most niche
  repos have no score. Absence must renormalise the quality axis, never score as zero.
- **The analyzer's GitHub calls come out of the crawler's quota.** Budget them explicitly or use
  a second token, or a busy analyzer will starve the crawler.
- **Signal freshness drifts from repo freshness**: a repo unchanged for a year still needs its
  Scorecard refreshed weekly. Analysis is triggered by `content_hash` change *or* by the oldest
  signal's TTL expiring — not by `content_hash` alone.
- **Deep pagination is capped** by `pagination.maxTotalHits`; admin listing uses `getDocuments`.
- README relative image paths break unless rewritten — test with `kubernetes/kubectl`.
- Plenty of repos mention Kubernetes without being ecosystem tools (courses, blogs, dotfiles).
  `k8s_relevance` demotes them: keep them in cache, filter them out at projection time.
- Homebrew formula names rarely match repo names (`ahmetb/kubectx` → `kubectx`). Verify against
  the Homebrew API, and cache that API response.
- The GitHub 5000 points/hour budget is shared by all crawler shards. Don't parallelise past the
  configured concurrency; give each shard its own token or divide the budget in config.
- Next.js: `revalidate` on the tool page won't help if the route reads a `cookies()`-tainted
  helper — it silently becomes dynamic. Keep portal routes free of request-scoped APIs.
- Long work cannot run inside a route handler (timeouts). Handlers enqueue; workers execute. A
  `for` loop over 10k repos in `app/api` is always a bug.
- Server actions are POST endpoints: authorize inside them, always.

## 15. Definition of done

1. `pnpm check && pnpm test` green.
2. Analyzer changes: re-run over the fixture set, diff the classification output, no unexplained
   regressions. New signal provider ⇒ cached adapter, TTL, timeout, null-path tested.
3. Read-model changes: applied by re-projecting from cache — **no network calls at all** — and
   promoted by alias swap, never in place.
4. API changes: contract updated in `@keco/core`, REST + MCP both reflect it.
5. Portal changes: tool page works with JS disabled (SEO), search is keyboard-navigable.
6. Nothing on the read side writes; nothing on the write side reads a read model.
7. Update this file when a contract changes; `docs/` when the taxonomy changes.