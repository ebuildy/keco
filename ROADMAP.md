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

- ⬜ **crawler** — registry seeds (CNCF landscape, krew index, Artifact Hub, OperatorHub,
  curated `awesome-*`) before keyword search; sharded GitHub Search by stars/created windows;
  GraphQL for bulk metadata, REST for README/tree/releases; ETag on everything; skip rules with
  a recorded reason.
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

- 🚧 **Search** — ported to the Vite SPA with URL-synced state and browser-direct Meilisearch
  queries. Still to do: facet sidebar, list/grid toggle, keyboard navigation, richer empty
  states.
- 🚧 **Tool page** — ported, prerendered for the top 1000 by score, README rendered from the
  cache by `apps/api` (sanitised, relative URLs rewritten, badge paragraph stripped, Shiki).
  Still to do: install tabs, adopters with an `evidence_url`, score breakdown UI.
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
