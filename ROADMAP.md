# Roadmap

The ordering principle: **the product is the data quality.** A surface is only worth building
once the corpus underneath it is worth surfacing, so v1 finishes the pipeline before v2 opens
new front doors.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## v0 — scaffold ✅

The skeleton, the contracts and the guard rails, with nothing faked.

- ✅ mise toolchain + task runner; pnpm workspaces, TypeScript strict, ESM
- ✅ `@keco/core` — taxonomy, event schemas, `AnalysisSchema`, `ToolDocument`, scoring
- ✅ `@keco/cache` — storage port, filesystem adapter, journal, checkpoints, `contentHash`
- ✅ `@keco/search` — index settings, async task handling, rebuild + alias swap
- ✅ `@keco/query` — the five retrieval functions shared by portal, REST and MCP
- ✅ Import boundaries of §7 enforced by lint, and proven by deliberate violations
- ✅ Portal, admin and API route skeletons; `mise run ci` green
- ✅ Read side on Vite + Fastify: static SPA, build-time prerender, one Node process

---

## v1 — the corpus

Everything needed for Keco to be genuinely useful once. No accounts, no curation, no chat.

### Write side

- ✅ **crawler** — fetches the `discovery_repos` corpus (GitHub Search, via `discovery sweep`),
  the only trust source right now; REST with one conditional request per repo (not GraphQL — see
  `docs/adr/0003-crawler-rest-not-graphql.md`); ETag on everything; skip rules with a recorded
  reason; run history in `crawl_history`. `--repo` crawls one named repo, or every repo already
  discovered under a bare org. Icons shipped ahead of it: `apps/workers/src/crawler/icon.ts`
  finds a project's mark (committed logo → README image → owner avatar), stores the bytes
  verbatim and derives 32/64/160 PNGs with sharp. `mise run repo:icon -- --repo owner/name` runs
  the pipeline standalone. See `docs/superpowers/specs/2026-08-24-project-icons-design.md`.
  Registry seeds (CNCF landscape, krew index, Artifact Hub, OperatorHub, curated `awesome-*`)
  fed this worklist directly until `docs/adr/0004-remove-crawler-seeds.md` — see "Known gaps and
  approximations" below for where that data goes instead.
- ⬜ **analyzer pass 1** — local rules over cached payloads, each new rule shipping with a
  fixture that proves it.
- ⬜ **analyzer pass 2** — Scorecard, deps.dev, OSV, Homebrew, krew, Artifact Hub behind the TTL
  cache; a dead provider degrades to `null` + `partial_signals[]` and never stalls the pipeline.
- ⬜ **analyzer pass 3** — LLM only for what rules and signals left ambiguous; structured output
  validated by `AnalysisSchema`; one retry, then an honest low-confidence fallback.
- ⬜ **projector** — the four score axes, quality renormalised over available signals, momentum
  z-scored across the corpus; batched upserts; `repos_state` written from the same events.
- ⬜ **re-analysis triggers** — `content_hash` change *or* the oldest signal's TTL expiring.
  Signal freshness drifts from repo freshness; a repo unchanged for a year still needs its
  Scorecard refreshed.

### Read side

- ✅ **Search** — URL-synced state, browser-direct Meilisearch queries, facet sidebar built from
  the distribution the search query already returned, list/grid toggle, sort, active-filter row,
  keyboard navigation (`/`, arrows, enter, escape) and empty states that suggest a next step.
- 🚧 **Tool page** — prerendered for the top 1000 by score, README rendered from the cache by
  `apps/api` (sanitised, relative URLs rewritten, badge paragraph stripped, Shiki), install tabs
  with registry proof, a project icon beside the heading, and a score breakdown showing
  `quality_coverage`. Still to do: adopters with an `evidence_url` — blocked on the projector
  emitting them, not on the UI.
- ✅ **Theme** — light/dark design system across all four routes, tokens through Tailwind v4's
  `@theme inline`, applied before first paint and asserted by the prerender. Colour encodes state
  rather than taxonomy category, and every text token clears WCAG 4.5:1. See
  `docs/superpowers/specs/2026-08-24-portal-theme-design.md`.
- ⬜ **Backoffice** — pipeline health from `repos_state` (phase counts, failures, skip reasons,
  confidence distribution, quota, checkpoint lag), repo inspector showing cache → analysis →
  projected document side by side, enqueue-only commands, taxonomy facet counts.
- ✅ **Auth** — single admin credential (`ADMIN_PASSWORD_HASH`, scrypt, signed HttpOnly
  session), re-checked inside every handler. Replaces the Auth.js + GitHub OAuth plan.
- ✅ **Portal mock backend** — dev-and-test-only MSW corpus so frontend work needs no crawl.
  Never in a production build; see `docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md`.

### Operations

- ⬜ **Object storage** — the S3/R2 adapter behind the existing `Storage` port, plus the
  read-only credential for the web app. Deliberately deferred: an unused, untested S3 client is
  weight without value, so it lands with the deployment that needs it.
- ⬜ **Scheduling** — continuous crawler with a weekly full sweep; analyzer and projector loops.
- ⬜ **Deploy** — Dockerfiles, deploy manifests, CI running `mise run ci`.

### Known gaps and approximations (crawler)

Recorded here so they stay findable rather than becoming tribal knowledge:

- Fork divergence is approximated by the 200-star threshold. Determining real divergence needs a
  compare API call per fork — a request spent to decide whether to spend requests, on the
  cheapest category of repo in the corpus. Revisit if forks turn out to pollute the corpus.
- `RepoFetched{changed:false}` is emitted for every unchanged repo on every sweep, which is
  ~30k tiny journal entries a week on a full corpus. It is what AGENTS.md §3 declares and what
  makes the analyzer's `!event.changed` filter meaningful. If journal size becomes a problem,
  the one-line fix is to emit only on change — at the cost of losing the per-repo "checked at
  time T, unchanged" record.
- The crawler's live progress bar (`lib/progress.ts`, via `createProgress()`) still displays
  discovery's own text — `"discovering"` and `"window N/M"` — even while a crawl is running,
  because generalizing `ProgressSnapshot`'s field names (this plan, the `ProgressSnapshot`
  rename) didn't extend to the hardcoded display strings. An operator watching a live
  `kecoctl repo crawl` sees a misleading label. Fix is a small parameterization of `render()`'s
  verb and unit words, deferred here rather than folded into this plan's scope.
- **Registry seeds were removed** (`docs/adr/0004-remove-crawler-seeds.md`): CNCF's landscape,
  krew's index, Artifact Hub/OperatorHub and curated `awesome-*` lists used to feed repos into
  the crawler's worklist directly, as a second discovery path alongside GitHub Search. GitHub
  Search (via `discovery sweep`) is now the only trust source for *which* repos are in the
  corpus. That registry data is still valuable — it's exactly what `maturity` and `governance`
  (§6 of AGENTS.md) need — but it belongs in the analyzer as an enrichment signal keyed off a
  repo GitHub already found, not as a way to add repos GitHub Search didn't surface. Re-adding it
  there is future work, not scoped yet.

**Done when:** a cold `mise run pipeline` produces a corpus a Kubernetes engineer would trust,
and a full rebuild from cache runs offline with zero GitHub calls.

---

## v2 — the signal and the conversation

- ⬜ "Alternatives to X" pages, comparison view, momentum board, evidence-backed adopters.
- ⬜ **Public API** — `/api/v1/search`, `/tools/{owner}/{repo}`, `/compare`; typed by the same
  `@keco/core` schemas that generate the MCP tool shapes.
- ⬜ **MCP endpoint** — `https://keco.dev/mcp`, so Claude, Cursor, Copilot and any agent can
  query the ecosystem while you work:

  | Tool | Use |
  |---|---|
  | `search_tools` | natural-language or faceted query over the corpus |
  | `get_tool` | full metadata, health breakdown, verified install commands |
  | `compare_tools` | side-by-side on maintenance, install, license, adoption |
  | `find_alternatives` | "what else does what ArgoCD does" |
  | `whats_hot` | high-momentum projects in a domain |

  Ask your agent *"what's the healthiest ingress controller with a Helm chart?"* and it answers
  from Keco instead of from stale training data. Agents recommend tools constantly and are
  systematically out of date — this may be Keco's strongest surface.

- ⬜ **Hybrid search** — embedder configured on the index, keyword + vector retrieval.
- ⬜ **Chatbot** — describe your problem, get tools. RAG over the corpus, not a general chatbot:
  answers **only** from retrieved tools, every claim linked to a Keco page, install commands only
  from verified metadata. It says "I don't know" rather than inventing a project.
- ⬜ **Evals** — ~50 real devops questions with expected tools, in `packages/query/evals`.
  Retrieval quality you can't measure will rot.
- ⬜ **Chat traces** — weak-retrieval queries logged to `traces`, feeding the eval fixtures.

---

## v3 — the surface

- ⬜ `keco` CLI — `keco search ingress`, `keco install k9s`.
- ⬜ Embeddable health badges.
- ⬜ Curated stacks — "a production GitOps setup in 6 tools".

---

## Explicitly not planned

These are not backlog items; they are decisions. See §1 of [AGENTS.md](./AGENTS.md).

- A database. The cache plus the journal is the write model, deliberately.
- Human curation, overrides, moderation queues, editorial content. A misclassification is fixed
  in the analyzer's rules, where it fixes every similar repo at once.
- Historical metrics, star history, "trending this week". With no time series, momentum is the
  honest substitute and it is labelled as such.
- End-user accounts, comments, votes. The portal is anonymous and read-only.
- Hosting packages or proxying downloads.
