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
| App | **Vite + React** (portal), **Fastify** (API) | Two static SPA bundles behind one Node process; build-time prerender gives static-fast tool pages |
| Read model | **Meilisearch** | Instant, typo-tolerant, first-class faceting; alias-swapped rebuilds |
| Write model | **A directory** (`.cache/`), behind a storage port | Raw GitHub JSON, READMEs and third-party responses, verbatim + TTL'd. Keys only, no queries, no database. Object storage swaps in for v2 |
| Signals | Scorecard · deps.dev · OSV · brew · krew · Artifact Hub | Real maintenance and security data instead of star-counting |
| Coordination | Append-only journal + checkpoints | No queue server, no locks — workers are idempotent and shard deterministically |
| Auth | Single admin credential — scrypt + signed HttpOnly session cookie | Backoffice only, one admin, checked inside every handler |
| Agents | MCP over streamable HTTP | Same query layer as the REST API |

## Quickstart

[mise](https://mise.jdx.dev) installs the toolchain and runs every task in this repo.

```bash
mise install                                 # node + pnpm, pinned in mise.toml
mise run setup                               # .env, dependencies, Meilisearch, index settings + search key
                                             # then add GITHUB_TOKEN to .env

mise run dev                                 # portal http://localhost:5173 (proxies /api to :3000)

# fill a small corpus (~200 repos, a few minutes)
mise run repo:crawl -- --seed cncf,krew --limit 200
mise run repo:analyze
mise run project
```

`mise run build` builds the portal and prerenders its top tool pages into `apps/web/dist`;
`mise run api` then serves that directory (and the JSON routes) on `http://localhost:3000` —
that combined, single-process address is the one a deployment actually answers on.

Re-classify everything from cache, without re-fetching:

```bash
mise run checkpoint:reset -- --consumer analyzer
mise run repo:analyze && mise run rebuild
```

`mise tasks` lists the rest — `check`, `lint`, `test`, `ci`, `search:settings`, `search:key`,
`infra:up|down|reset`.

The only service you need locally is Meilisearch. The cache is a directory, so wiping the write
model is `rm -rf .cache` and rebuilding it is a crawl.

### Environment

Full list with per-variable notes in [`.env.example`](./.env.example); the ones that matter:

```ini
GITHUB_TOKEN=                    # classic PAT, public_repo scope — workers only
CACHE_DIR=.cache                 # the write model; workers write, apps/api reads by key
MEILI_HOST=
MEILI_MASTER_KEY=                # apps/api + projector only, never shipped to the browser
VITE_MEILI_HOST=                 # apps/web — the browser talks to Meilisearch directly (§9)
VITE_MEILI_SEARCH_KEY=           # search-only key, scoped to `tools` — `mise run setup` mints this for you
SITE_URL=                        # canonical links, the sitemap, and the admin cookie's Secure flag
WEB_DIST=                        # where `vite build` put the portal; apps/api serves it
PORT= / HOST= / TRUST_PROXY=     # apps/api's listener — TRUST_PROXY only true behind a proxy you control
SESSION_SECRET=                  # signs the admin session cookie — 32 characters minimum
ADMIN_PASSWORD_HASH=             # scrypt$salt$key — generate with `mise run admin:hash`
COMMAND_TOKEN=                   # /api/commands/* in place of an admin session
ANTHROPIC_API_KEY=               # analyzer fallback + chatbot
```

## Roadmap

**v1 — the corpus.** Crawler, analyzer and projector doing real work; portal search and tool
pages; backoffice observability. **v2 — the signal and the conversation.** Public API, MCP
endpoint, hybrid search, grounded chatbot. **v3 — the surface.** `keco` CLI, health badges,
curated stacks.

The current state of each, and what is deliberately *not* planned, is in
[ROADMAP.md](./ROADMAP.md).

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

Each deployable then documents its own architecture, how to run it and what it's held to:

- [`apps/web`](./apps/web/README.md) — the public portal: static SPA, browser-direct search,
  build-time prerender.
- [`apps/api`](./apps/api/README.md) — the only backend process: REST, README rendering, admin
  auth, commands, and serving the bundle.
- [`apps/workers`](./apps/workers/README.md) — the write side: discovery, crawler, analyzer,
  projector, and the cache they share.

## License

Apache-2.0 for the code. Crawled metadata remains under the terms of its sources.# keco
