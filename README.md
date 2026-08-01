# Keco — the Kubernetes Ecosystem search engine

> Find the right Kubernetes tool in 10 seconds, not 10 browser tabs.

Keco crawls GitHub for everything orbiting Kubernetes — CLIs, kubectl plugins, operators, Helm
charts, dashboards, policy engines, distributions — classifies it, scores its health, figures
out **how to actually install it**, and makes it searchable by humans and by agents.

## The problem

You need "a tool to see what's eating my cluster's memory". Today that means googling, landing
on a 2019 blog post, opening `awesome-kubernetes` (last updated 8 months ago), finding three
candidates, then manually checking whether each is still maintained and whether there's a
Homebrew formula. Artifact Hub only covers packages. The CNCF landscape only covers CNCF
projects. GitHub search ranks by stars, which rewards famous corpses.

Keco is the missing index: the whole ecosystem, classified, and ranked by *health* not fame.

## Architecture — CQRS, no database

Every piece of data in Keco is derived from public GitHub data. Nothing is precious, nothing is
edited by hand, everything is reproducible. That makes a clean command/query split possible:

```
        ┌───────────────── WRITE SIDE ─────────────────┐
GitHub  │  crawler ──▶ CACHE ──▶ analyzer ──▶ projector│
  API   │  (fetch)    (raw)     (classify)    (build)  │
        │              └─── journal of events ───┘     │
        └──────────────────────┬───────────────────────┘
                               │
        ┌──────────────────────▼───────────────────────┐
        │  READ MODELS — Meilisearch                   │
        │  `tools` (public)  ·  `repos_state` (admin)  │
        └──────────────────────┬───────────────────────┘
                               │ query only
          portal · REST API · MCP · chatbot · backoffice
```

**The cache is the write model.** Object storage holding GitHub API responses, README markdown
and every third-party signal response, verbatim and TTL'd — no transformation on write, so a
parser bug is fixed by re-analyzing rather than re-fetching.

**Meilisearch is a read model.** Disposable, rebuildable from the cache in minutes with zero
GitHub calls, alias-swapped on every rebuild.

**The three workers never talk to each other.** They communicate through the cache and an
append-only event journal, each tracking its own checkpoint:

| Worker | Reads | Writes | Network |
|---|---|---|---|
| **crawler** | seeds, `RepoDiscovered` | cache, `RepoFetched` | GitHub, rate-limited |
| **analyzer** | `RepoFetched` | analyses, `RepoAnalyzed` | signal providers + AI, all cached |
| **projector** | `RepoAnalyzed` | Meilisearch | none |

The payoff: because every fetch — GitHub, Scorecard, deps.dev, registries — lands in the cache
with a TTL, re-classifying the whole corpus after a rule change, a prompt change or a taxonomy
change costs almost nothing and doesn't touch anyone's rate limit. Replay is normal operation,
not an incident. And the projector is pure — cache in, index out — so rebuilding the search
index is entirely offline.

A `content_hash` over each repo's cached payload gates everything downstream: unchanged hash and
unexpired signals means no analysis, no AI call, no re-projection.

## What it does

**Portal** — home with a big search box and the tools with the most momentum; Google-like search
with instant typo-tolerant matching, list/grid views, filters (kind, domain, install method,
language, license, maintenance) and sorting by relevance, stars, health or last commit. Query
state lives in the URL, so results are shareable. Tool pages render the README with a GitHub
card, verified install commands, related tools and evidence-backed adopters.

**Backoffice** — observe and command, never edit. Pipeline health and checkpoint lag, per-repo
inspection (cached payload → analysis → projected document, side by side, so you can see which
stage got it wrong), and buttons that enqueue: re-crawl, re-analyze, rebuild index, rollback
alias. There is no "edit this field" form on purpose — a misclassification gets fixed in the
analyzer's rules, where the fix improves every repo instead of one.

**API** — public read-only REST, plus an **MCP endpoint** so coding agents can query the
ecosystem.

## Classification and ranking

Three passes, cheapest first.

**Rules** settle most repos deterministically and for free: repo topics, file tree
(`Chart.yaml`, `config/crd/`, `.krew.yaml`) and dependency manifests
(`sigs.k8s.io/controller-runtime`, `k8s.io/client-go`).

**External signals** add what GitHub's API can't tell you — OpenSSF Scorecard (code review, CI
tests, signed releases, branch protection, maintenance), deps.dev (dependents across
ecosystems), OSV (known vulnerabilities), and the registries that prove an install method
actually exists. Each provider is cached with its own TTL and hard timeout, and a provider being
down degrades the result instead of failing the repo.

**AI** only sees what's still ambiguous, and its output is schema-validated before it's written.

Every classification records which pass produced it, which model, which signals were used, and
when each was fetched — so any result can be explained, dated and reproduced.

Two axes, never one: **kind** (what it *is* — cli, operator, helm-chart, controller…) and
**domains** (what it *solves* — networking, security, observability, gitops…). Cilium is both a
controller and networking; a flat category list can't express that.

Ranking is **not** raw stars:

```
0.35 · popularity   log-compressed stars
0.30 · activity     recent commits, release cadence, last push, Scorecard::Maintained
0.20 · adoption     krew / brew / Artifact Hub / CNCF landscape + deps.dev dependents
0.15 · quality      license, releases, docs, Scorecard checks, minus open vulnerabilities
```

An archived 30k-star project ranks below a healthy, maintained 800-star one — as it should when
you're choosing what to run in production.

Scorecard only covers projects in OpenSSF's weekly scan, so most niche repos have no score.
Missing is treated as *unknown*, not as zero: the quality axis renormalises over the signals
that exist, and each tool page shows how much of the score is actually backed by data. Scoring a
project badly because nobody audited it would quietly bias the entire corpus toward the famous.

Install methods are **detected and verified, never guessed**: each one carries a real command
and a link to the registry entry proving it exists. If it can't be proven, it isn't shown. A
wrong `brew install` line is worse than no line at all — people paste these into a terminal.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js 15**, App Router, RSC | Portal, backoffice and APIs in one codebase; ISR gives static-fast tool pages |
| Read model | **Meilisearch** | Instant, typo-tolerant, first-class faceting; alias-swapped rebuilds |
| Write model | **Object storage** (S3/R2/MinIO) | The cache: raw GitHub JSON, READMEs and third-party responses, verbatim + TTL'd. Keys only, no queries |
| Signals | Scorecard · deps.dev · OSV · brew · krew · Artifact Hub | Real maintenance and security data instead of star-counting |
| Coordination | Append-only journal + checkpoints | No queue server, no locks — workers are idempotent and shard deterministically |
| Auth | Auth.js, GitHub OAuth | Backoffice only, allowlisted logins |
| Agents | MCP over streamable HTTP | Same query layer as the REST API |

## Quickstart

[mise](https://mise.jdx.dev) installs the toolchain and runs every task in this repo.

```bash
mise install                                 # node + pnpm, pinned in mise.toml
mise run setup                               # .env, dependencies, Meilisearch + MinIO, index settings
                                             # then add GITHUB_TOKEN to .env

mise run dev                                 # http://localhost:3000

# fill a small corpus (~200 repos, a few minutes)
mise run crawler -- --seed cncf,krew --limit 200
mise run analyzer
mise run projector
```

Re-classify everything from cache, without re-fetching:

```bash
mise run replay -- --consumer analyzer
mise run analyzer && mise run rebuild
```

`mise tasks` lists the rest — `check`, `lint`, `test`, `ci`, `search:settings`, `infra:up|down|reset`.

### Environment

```
GITHUB_TOKEN=                    # classic PAT, public_repo scope — crawler only
CACHE_ENDPOINT= / CACHE_BUCKET=  # S3-compatible; workers read-write, web read-only
CACHE_ACCESS_KEY= / CACHE_SECRET=
MEILI_HOST=
MEILI_MASTER_KEY=                # server + projector only, never shipped to the browser
NEXT_PUBLIC_MEILI_SEARCH_KEY=    # search-only key, scoped to the `tools` index
COMMAND_TOKEN=                   # /api/commands/* (backoffice triggers)
AUTH_GITHUB_ID= / AUTH_SECRET=   # backoffice login
ADMIN_LOGINS=                    # comma-separated GitHub logins allowed in /admin
ANTHROPIC_API_KEY=               # analyzer fallback + chatbot
```

## Roadmap

**v1 — the corpus**
Crawler, cache, analyzer, projector; taxonomy, health scoring, verified install methods; portal
search and tool pages; backoffice observability.

**v2 — the signal & the conversation**

- "Alternatives to X" pages, comparison view, momentum board, evidence-backed adopters.
- **Public API** — `/api/v1/search`, `/tools/{owner}/{repo}`, `/compare`.
- **MCP endpoint** — `https://keco.dev/mcp`, so Claude, Cursor, Copilot and any agent can query
  the ecosystem while you work:

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

- **Chatbot** — describe your problem, get tools. RAG over the corpus, not a general chatbot:
  retrieval via Meilisearch hybrid search, answers **only** from retrieved tools, every claim
  linked to a Keco page, install commands only from verified metadata. It says "I don't know"
  rather than inventing a project.

**v3 — the surface**
`keco` CLI (`keco search ingress`, `keco install k9s`), embeddable health badges, curated stacks
("a production GitOps setup in 6 tools").

## Data and correctness

All data comes from public GitHub metadata and public registries. Keco stores no packages and
proxies no downloads; every tool page links back to its source repository, shows its license,
and states when it was last indexed. Install commands appear only when verified against a real
registry entry.

Something misclassified? Open an issue with the repo URL — the fix is a rule in the analyzer,
which means it fixes every similar project at the same time.

## Contributing

See [AGENTS.md](./AGENTS.md) — written for AI coding agents, but it's the most precise spec of
the system, so read it first either way.

## License

Apache-2.0 for the code. Crawled metadata remains under the terms of its sources.