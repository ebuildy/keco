# Crawler — design

Date: 2026-09-05
Status: proposed, partially superseded 2026-09-07 and 2026-09-08 (see amendments)
Supersedes the `TODO(crawler)` block in `apps/workers/src/crawler/index.ts`.

> **Amendment, 2026-09-08 — `seeds/` renamed to `sources/`.** Once the 2026-09-07 amendment left
> `seeds/github/` as the only thing under `crawler/seeds/`, the name no longer fit — nothing
> there answers "which repos to crawl" anymore, only "what is in one." Every `seeds/github/…`
> path below is now `crawler/sources/github/…`; left unchanged in the text, as elsewhere in this
> document, rather than mechanically rewritten.
>
> **Amendment, 2026-09-07 — registry seeds removed.** §2 item 1, §3's `seeds/{index,cncf,krew,
> artifacthub,operatorhub,awesome}.ts` and `external.ts`, §4's "seeds in --seed order" stage, §7
> in full, the `--seed` CLI surface in §9, and the `seed_errors[]` field in §6 describe a
> mechanism that no longer exists: `discovery_repos` (GitHub Search) is now the crawler's only
> worklist source, plus the `--repo owner/name|org` bypass. Every entry a registry seed used to
> contribute is itself a GitHub repo GitHub Search already finds, so the registry data is
> evidence about a repo already in the corpus (feeding `maturity`/`governance`), not a second way
> to discover one. See `docs/adr/0004-remove-crawler-seeds.md` for the reasoning and
> `docs/adr/0002` / AGENTS.md §4.1 for why `discovery_repos` is the crawler's sole input.
> Everything else below — skip rules (§5.2), `crawl_history` minus its seed fields (§6), the
> per-repo fetch pipeline (§5), icons (§7.5, since moved out of the removed §7), concurrency and
> shutdown (§8) — is unchanged and still describes what's built. The rest of this document is
> left as it was written, as the historical record of the original design; sections superseded by
> the amendment are marked inline below rather than rewritten.

## 1. Context

`runCrawler` is a documented stub. Everything around it exists and is tested:

| Already built | Where |
|---|---|
| `Storage` port, `Cache`, atomic writes, `repoKeys`, `externalKey` | `packages/cache` |
| `contentHash()` — the change signal for the whole pipeline | `packages/cache` |
| `Journal.append/read`, checkpoints | `packages/cache` |
| `GitHubClient.conditional()` — ETag, 304/404, 403/429 backoff, quota governor | `packages/github` |
| `updateIcon()` + the three-tier candidate rules, fixture-tested | `apps/workers/src/crawler/icon*.ts` |
| `DataStore` port + three conformant implementations | `apps/workers/src/lib`, `cli/data-store.ts` |
| `discovery_repos` — the enumerated candidate corpus | `apps/workers/src/discovery/store` |
| `installShutdown`, `createProgress`, `perItem`, `ownsShard` | `apps/workers/src/lib`, `packages/github` |
| `kecoctl repo crawl --seed --limit --repo` argument surface | `apps/workers/src/cli/program.ts` |

So this is a fill-in-the-middle job. The crawler is the last unimplemented piece of the write
side before the analyzer.

## 2. Scope

Everything AGENTS.md §4.2 asks of the crawler:

1. ~~Registry seeds — CNCF landscape, krew index, Artifact Hub, OperatorHub, curated
   `awesome-*`~~ — removed 2026-09-07, see the amendment above.
2. Skip rules, emitted as `RepoSkipped` with a reason, never dropped silently
3. Per-repo fetch — metadata, README, tree, releases, manifests
4. Verbatim writes + `contentHash()` + `_fetch.json` + `RepoFetched`
5. Icons, inline, via the existing `updateIcon()`

Plus one addition not in AGENTS.md: a **`crawl_history` collection**, one document per crawl
run, so a crawl leaves a run record the way a discovery sweep does. Today it leaves none.

Out of scope: caching README *body* images (icons only — see §7.5); a GraphQL client (§10.1);
`k8s_relevance` (§10.2).

## 3. Module layout

`runCrawler` stays a loop. Every decision lives in a module beside it that a test can reach
with no network, no cache and no Meilisearch — the shape `runDiscovery` already has.

```
apps/workers/src/crawler/
  index.ts              runCrawler — the loop, shutdown, progress, run record
  worklist.ts           discovery_repos + the --repo bypass → one sharded, capped stream
  store/
    collections.ts      PURE  crawl_history spec + mappers
    store.ts            CrawlHistoryStore over the DataStore port
  seeds/
    github/
      fetch.ts          the per-repo pipeline (the one impure module)
      readme.ts         PURE  README response → { markdown, meta }
      manifests.ts      PURE  tree paths → manifest files worth fetching
      skip.ts           PURE  repo.json → { skip, reason } | null
      icon.ts  icon-candidate.ts  icon-run.ts   (moved, unchanged)
      icon.test.ts  icon-candidate.test.ts      (moved, unchanged)
```

As originally built, `seeds/` also held `index.ts` (a registry: name → adapter) and five
ref-yielding adapters (`cncf.ts`, `krew.ts`, `artifacthub.ts`, `operatorhub.ts`, `awesome.ts`),
plus a shared `external.ts` cache helper only they used — all removed 2026-09-07 (see amendment).
`seeds/github/` was deliberate and asymmetric even then: the other five adapters answered *which*
repos to crawl, `github/` answers *what is in one*, which is why it's the only survivor — nothing
about "what is in a repo I already decided to crawl" depended on how that repo was found.

`runCrawler` takes `{ dataStore }` as a dependency exactly as `runDiscovery` does — it needs
`discovery_repos` to read and `crawl_history` to write. `eslint.config.mjs` already bans
`@keco/search` and `meilisearch` from `crawler/**`, so the port is the only legal shape and
`cli/data-store.ts` remains the only file naming a backend.

## 4. The work list (`worklist.ts`)

As built 2026-09-05, then amended 2026-09-07 to drop the seed stage (ADR 0004):

```
--repo owner/name  ─────────────────────────────────► [that one repo]
--repo org (no slash)  ──► discovery_repos where owner = org ─► [every repo under it]

otherwise:
  discovery_repos ────────► dedupe ─► ownsShard() ─► --limit ─► stream
   (DataStore.list, sort stars desc)   (SHARD_COUNT/INDEX)
```

~~seeds in --seed order ─┐~~
~~                       ├─► dedupe ─► ownsShard() ─► --limit ─► stream~~ — removed; see below.
~~discovery_repos ───────┘~~

- ~~Seeds run first: AGENTS.md §4.2 calls them higher signal than keyword search, and a
  `--limit` run should spend its budget on them.~~ No longer applicable — `discovery_repos` is
  the only source.
- `discovery_repos` is read `sort: [['stars','desc']], limit: N` — the collection declares
  `stars` sortable. A capped run then gets the most valuable repos rather than an arbitrary page.
- ~~Dedupe is on `owner/repo`, lowercased. A repo reachable from three seeds is crawled once; the
  first source to yield it wins and is recorded as `_fetch.json.source`.~~ Dedupe is still on
  `owner/repo`, lowercased — it now only matters for the discovery corpus itself, since it's the
  only source.
- The crawler keeps **no checkpoint**. `CONSUMERS` is `['analyzer','projector']` and the §4 table
  lists the crawler's input as the collection, not the journal. Its idempotence comes from ETags,
  not from an offset.

`worklist.ts` imports `REPOS` from `discovery/store/collections` — the collection name is a
shared fact, and duplicating the string is how the two drift.

## 5. Per-repo fetch (`seeds/github/fetch.ts`)

```
_fetch.json → { etags, fetched_at, content_hash, source }

GET /repos/{owner}/{repo}                  If-None-Match: etags.repo
  ├─ 404 ──► RepoSkipped{ reason: 'not-found' }                        STOP
  ├─ 304 ──► RepoFetched{ content_hash: <stored>, changed: false }     STOP  ← 3 requests saved
  └─ 200 ──► skip.ts
               ├─ skip ──► RepoSkipped{ reason }                       STOP  ← before spending requests
               └─ keep
                    GET /repos/{o}/{r}/readme                      conditional
                    GET /repos/{o}/{r}/git/trees/{branch}?recursive=1  conditional
                    GET /repos/{o}/{r}/releases?per_page=10        conditional
                    raw.githubusercontent → manifests/             (costs no API quota)
                    contentHash(repo, readme, treePaths)
                    updateIcon(...)                                (never throws)
```

### 5.1 The 304 short-circuit

A 304 on `/repos` short-circuits the whole repo. This rests on one assumption, stated here
because it is load-bearing: **GitHub computes the repo ETag over the response body, which
includes `pushed_at`.** An unchanged repo document therefore means no push since the last crawl,
so README, tree and releases cannot have changed either.

Guard: a `_fetch.json` whose `fetched_at` is more than **30 days** old re-fetches everything
regardless of the 304. If the assumption is ever wrong, a stale entry self-heals within a month
instead of going permanently stale. This is the single largest cost control in the crawler — it
is what makes AGENTS.md §4's weekly full sweep affordable.

### 5.2 Write order — crash safety

```
1. artifacts   repo.json, readme.md, readme.json, tree.json, releases.json, manifests/, icon.*
2. journal     RepoFetched
3. _fetch.json etags + content_hash + fetched_at + source
```

Deliberately in that order. A crash between 2 and 3 re-crawls the repo next run and re-emits
`RepoFetched` — duplicate work, which is free and idempotent because the analyzer keys on
`content_hash`. The reverse order loses the event silently and the analyzer never learns the
repo exists. **Duplicate events are safe; lost events are not.**

Every individual `put` is atomic (`Storage`'s contract), so no single artifact can tear.

### 5.3 README (`readme.ts`, pure)

`GET /repos/{o}/{r}/readme` returns `{ path, content (base64), encoding }`. The module decodes
to verbatim markdown and derives:

```
readme.json = {
  path,                       // e.g. "docs/README.md"
  branch,                     // repo.json default_branch
  etag,
  image_base_url              // https://raw.githubusercontent.com/{full_name}/{branch}/{dirname}/
}
```

`image_base_url` always ends in `/` and is always `https:`, matching the shape
`apps/api/src/routes/readme.ts` falls back to and the `ReadmeMetaSchema` it validates against.
Getting this wrong breaks every relative image in the corpus (§14), so it is pure and
fixture-tested against a root README and a nested one.

A 404 means no README: `readme.md` and `readme.json` are not written, and `contentHash` sees
`readme: null`.

### 5.4 Manifests (`manifests.ts`, pure)

Tree paths in, paths worth fetching out. Declared constant, root-only, plus the shallowest
`Chart.yaml` anywhere when the root has none (helm repos keep it at `charts/{name}/Chart.yaml`):

```
go.mod · Chart.yaml · package.json · Cargo.toml · pyproject.toml
```

Fetched from `raw.githubusercontent.com`, which **costs no API quota**. Bounded: at most 6
manifests per repo, 256 KB each, skipped past that. Tree-path-only signals the analyzer needs
(`.krew.yaml`, `PROJECT`, `config/crd/`) are already in `tree.json` and are not fetched.

### 5.5 Skip rules (`skip.ts`, pure)

Decided from `repo.json` alone, so a skip is decided *before* three requests are spent:

| Rule | Reason emitted |
|---|---|
| `fork && stars <= 200` | `fork` |
| `archived && pushed_at older than 24 months && stars <= 1000` | `archived-stale` |
| repo API 404 | `not-found` |

Each emits `RepoSkipped`. Nothing is dropped silently.

`ci-manifest-only` is **not** here — see §10.2.

## 6. `crawl_history`

One document per run, following `discovery_runs`' contract exactly.

```
crawl_history/{run_id}          run_id: ULID  (matches DOCUMENT_ID_PATTERN)
  outcome        running | complete | failed | interrupted
  started_at  finished_at  duration_ms
  limit  repo  shard_count  shard_index
  repos_seen  repos_fetched  repos_unchanged  repos_skipped  repos_failed
  icons_updated  requests  points_spent  rate_limited
```

As built 2026-09-05 this also carried `seeds[]` and `seed_errors[]  [{ name, error }]` — dropped
2026-09-07 with the seed mechanism itself (ADR 0004); a run's configuration is now fully
described by `limit`, `repo` and the shard fields.

`requests` counts every HTTP call the run made. `points_spent` counts only those that consumed
GitHub REST quota — 304s and `raw.githubusercontent.com` fetches are excluded, because both are
free and a number that conflated them would make the 304 short-circuit (§5.1) invisible in
exactly the record an operator reads to confirm it is working.

~~`seed_errors[]` is the minimum needed to keep a silently-empty seed visible: an Artifact Hub
outage that yields zero refs is otherwise indistinguishable from an Artifact Hub with nothing
new.~~ No longer applicable — removed with the seed mechanism (ADR 0004).

Spec: `primaryKey: 'run_id'`, `searchable: []` (a plain key-value store per AGENTS.md §5),
`filterable: ['outcome']`, `sortable: ['started_at','duration_ms','repos_fetched','requests']`.

Rules carried over from discovery, each for a reason already learned there:

- `open()` writes the document immediately with `outcome: 'running'`.
- `finishRun()` stamps the ending on **every** path out — complete, failed, and the shutdown
  handler's `interrupted`.
- A `SIGKILL` therefore leaves a run stuck at `running` forever, deliberately: that row is how an
  operator spots a crawl that died without cleanup. A later run quietly repairing it would hide
  exactly the failure someone is looking for.
- Counters are run-scoped. Reporting a resumed total as one run's cost is worse than reporting
  neither.

This is a *write-model* collection sharing the Meilisearch instance, exactly like the
`discovery_*` ones — the read side never queries it, and the projector remains the only writer
of searchable read models (ADR 0002).

It is **not** per-repo. AGENTS.md §5 assigns per-repo pipeline status to `repos_state`, owned by
the projector, and per-repo skip/failure facts are already durable in the journal.

## 7. Seeds — removed 2026-09-07, see ADR 0004

Everything in this section (§7 through §7.4, the original §7.5 renumbered below) described five
`SeedAdapter`s — `cncf`, `krew`, `artifacthub`, `operatorhub`, `awesome` — that fed repos into
the worklist directly, and the `external.ts` TTL-cache helper only they used. All of it was
deleted, not merely disabled: `crawler/seeds/{index,cncf,krew,artifacthub,operatorhub,
awesome}.ts`, `crawler/external.ts`, their tests and fixtures, the `--seed` CLI flag, and the
`seeds`/`seed_errors` fields on `crawl_history` (§6).

Kept as historical record — the reasoning below (data quality, OperatorHub's routing through
Artifact Hub, `awesome-*` list selection) is exactly why the amendment at the top of this
document says the *data* still matters, as a future analyzer signal rather than a discovery path:

<details>
<summary>Original §7 text (superseded)</summary>

Every adapter yielded `{ repo: 'owner/name', source: string }` and cached its upstream response
through `external.ts` into `external/{provider}/*.json` with a TTL envelope — so a parser fix
cost no network and a re-crawl re-parsed rather than re-downloaded.

| Adapter | Upstream | TTL | Notes |
|---|---|---|---|
| `cncf` | `cncf/landscape` `landscape.yml` via raw | 1 d | see below |
| `krew` | `kubernetes-sigs/krew-index` tree + `plugins/*.yaml` via raw | 1 d | one tree call (1 point), plugin YAML from raw (free) |
| `artifacthub` | `artifacthub.io/api/v1/packages/search`, paginated | 1 d | `repository.url` → `owner/repo` |
| `operatorhub` | Artifact Hub, OLM operator kind | 1 d | see below |
| `awesome` | declared list of `awesome-*` READMEs via raw | 1 d | see below |

A seed that failed yielded nothing and appended to the run document's `seed_errors[]` (§6); it
never aborted the crawl. AGENTS.md §4.2's "degrade, never fail" applied to seeds as much as to
signals.

**The CNCF seed earned its keep twice.** `landscape.yml` carries each project's maturity
(`graduated` / `incubating` / `sandbox`) and its foundation membership — exactly the lookup
`classifyDerived` needs for `maturity` and `governance`, which the analyzer TODO passed as `null`
— the reason AGENTS.md §6 says governance "will report `unknown` for most real foundation
projects until the CNCF landscape crawler ships a cached seed". This is still true and still
unimplemented; it is the leading candidate for the future analyzer signal the amendment above
points to.

**OperatorHub deviation.** Scraping `k8s-operatorhub/community-operators` means walking
`operators/*/` and reading a `*.clusterserviceversion.yaml` per operator — hundreds of fetches
for data Artifact Hub already indexes under its OLM operator kind. The `operatorhub` adapter
therefore queried Artifact Hub with a different kind filter: same source of truth, one HTTP
shape, far fewer requests.

**Which `awesome-*` lists.** AGENTS.md §4.2 said "curated `awesome-*` lists" and named none. The
adapter declared an explicit constant with a rationale per entry, starting with
`ramitsurana/awesome-kubernetes` and `tomhuang12/awesome-k8s-resources`. Markdown link extraction
was pure and fixture-tested; only `github.com/{owner}/{repo}` links were yielded, and links into
a repo's subpaths collapsed to the repo.

**`external.ts` duplicated `@keco/signals`' `Provider`.** `Provider` in `packages/signals` does
exactly this TTL-envelope caching, but AGENTS.md §7 bars everything except the analyzer from
importing `@keco/signals` — so `crawler/external.ts` was ~45 duplicated lines, accepted at the
time as a smaller cost than widening that boundary. Deleting it alongside the seeds resolved the
duplication a different way than anticipated.

</details>

### 7.5 Images

Icons only, via the existing `updateIcon()` called inline per repo: `icon.src` verbatim plus
`icon-{32,64,160}.png` derived by sharp. README *body* images keep loading from
`raw.githubusercontent.com` through the `image_base_url` rewrite `apps/api` already performs.

Icon bytes are deliberately **not** part of `contentHash()` — a logo that moves changes
`tree.json` and so changes the hash already, and folding the bytes in would invalidate the whole
corpus for a cosmetic field.

## 8. Concurrency, quota, shutdown

- **Concurrency**: `p-queue` at 8, as AGENTS.md §4 specifies. New dependency.
- **No `p-retry`**: `GitHubClient.conditional()` already retries 403/429 with `backoffMs()` and
  honours `retry-after`. A second retry layer over it would multiply, not add. Stated in the
  module doc so the deviation from §4's sentence is visible.
- **Quota**: the client's `QuotaGovernor` is fed by every response. Before each repo the loop
  checks `quota.exhausted` and, if so, finishes the run as `complete` with work remaining rather
  than sleeping for up to an hour inside a `mise run` — the next run resumes for free because
  every fetched repo now 304s. `points_spent` and `rate_limited` land on the run document.
- **Shutdown**: `installShutdown({ flush, done, log })`. `flush` finishes the in-flight repo's
  writes and calls `finishRun('interrupted')`. Per-repo work is already crash-safe (§5.2), so
  there is no batch to lose.
- **Per-item isolation**: every repo runs inside `perItem()`, which emits `RepoFailed{phase:'crawl'}`
  and continues. A single bad repo must never abort a run (§13).
- **Exit code**: 0 on `complete`, 1 only when the run itself aborts. A crawl of 30k repos where
  12 are gone is a successful crawl; per-repo failures are recorded in the journal and counted on
  the run document. This differs from `discovery sweep`, which exits 1 on any failed window,
  because a missing star band silently truncates a corpus whereas a missing repo does not.

## 9. CLI surface

As built 2026-09-05: `kecoctl repo crawl [--seed cncf,krew] [--limit 200] [--repo owner/name]`.
As of 2026-09-07 (ADR 0004 removed `--seed`; a later change added org support to `--repo`):
`kecoctl repo crawl [--limit 200] [--repo owner/name|org]`.

New:

```
kecoctl repo history [--limit 20] [--json]     mise run repo:history
```

Reads `crawl_history` sorted `started_at` desc and renders a table (or NDJSON), mirroring
`discovery list runs` and reusing its formatting approach. Like the discovery explore commands it
must `ensure()` its collection first: an unknown collection throws from every `DataStore`
implementation, and `repo history` on a fresh machine has no crawl in front of it.

`kecoctl index create` provisions `crawl_history` alongside `DISCOVERY_COLLECTIONS`.

## 10. Deviations from AGENTS.md, and what gets amended

### 10.1 REST + ETag, not GraphQL — ADR required

AGENTS.md §4.2 asks for GraphQL bulk metadata (≤100 repos/query) *and* ETag-conditional requests.
These conflict: GitHub's GraphQL API supports no conditional requests, and REST 304s cost zero
quota.

| | first crawl, 30k repos | weekly re-sweep |
|---|---|---|
| GraphQL bulk | ~300 points | ~300 points (no 304s) |
| REST + ETag | 30k points (~6 h) | ~0 points |

The weekly full sweep is the cadence §4 actually specifies, and REST+ETag is the cheaper steady
state by three orders of magnitude — while reusing a client that already exists and is tested.
The cold start is a one-time six hours.

This reverses a decision recorded in AGENTS.md, so per §15.7 it lands as
`docs/adr/0003-crawler-rest-not-graphql.md`, and §4.2 is amended to match.

### 10.2 `ci-manifest-only` stays with the analyzer

§4.2 lists "repos whose only Kubernetes link is a CI manifest" among the crawler's skip rules.
§14 says the opposite for the same repos: *"keep them in cache, filter them out at projection
time"*, and `k8s_relevance` is an analyzer-assigned field.

§14 wins. The crawler skips only what `repo.json` can decide before requests are spent; relevance
needs the README and tree it has not fetched yet, and re-deciding it after a rule change must not
require a re-crawl. §4.2's bullet is amended to point at the analyzer.

### 10.3 Fork divergence is approximated

§4.2 keeps a fork "unless > 200 stars **and diverged**". Divergence needs a compare API call per
fork — a request spent to decide whether to spend requests, on the cheapest category of repo in
the corpus. The star threshold is implemented; the approximation is named in `skip.ts`'s module
doc and in ROADMAP.md rather than left implicit.

### 10.4 `ProgressSnapshot` field names

`lib/progress.ts` declares `{ repos, windowsDone, windowsKnown, requests }` — discovery's
vocabulary. The crawler has repos, not windows. The fields are renamed to
`{ items, done, known, requests }` and `discovery/index.ts` plus `progress.test.ts` updated. A
mechanical rename; the alternative is the crawler passing repo counts under a field called
`windowsDone`, which is a lie in a module an operator reads.

## 11. Testing

Per AGENTS.md §13 and §15.1. Gate is `mise run ci`.

| Module | Test |
|---|---|
| `skip.ts` | unit — each rule, each boundary (200/1000 stars, 24 months), keep-path |
| `manifests.ts` | unit — root manifests, nested `Chart.yaml` fallback, the 6-file bound |
| `readme.ts` | unit — root README, nested README, base64 decode, `image_base_url` shape, 404 |
| ~~`seeds/*.ts`~~ | ~~unit against **committed fixtures** of each upstream payload~~ — removed with the seeds (ADR 0004) |
| `store/collections.ts` | unit — spec shape, mappers, counter derivation |
| `store/store.ts` | against the in-memory `DataStore`, incl. every `finishRun` path |
| `seeds/github/fetch.ts` | fake `GitHubClient` + in-memory `Cache` — 304 short-circuit, 404, write order, 30-day guard |
| `worklist.ts` | dedupe, shard filter, limit, `--repo` bypass (single repo and org) |
| `icon*.test.ts` | moved unchanged; they prove the move broke nothing |

No e2e — that is `apps/web` only.

## 12. Files touched

**New** — `crawler/worklist.ts`, `external.ts`, `store/{collections,store}.ts`,
`seeds/{index,cncf,krew,artifacthub,operatorhub,awesome}.ts`,
`seeds/github/{fetch,readme,manifests,skip}.ts`, their tests, seed fixtures, and
`docs/adr/0003-crawler-rest-not-graphql.md`. (2026-09-07: `external.ts` and every `seeds/*.ts`
above except `seeds/github/**` deleted again — ADR 0004.)

**Moved** — `crawler/icon.ts`, `icon-candidate.ts`, `icon-run.ts`, `icon.test.ts`,
`icon-candidate.test.ts` → `crawler/seeds/github/`.

**Modified** — `crawler/index.ts` (the loop), `cli/program.ts` + `cli/handlers.ts` (the `history`
command, the moved `icon-run` import, `crawl_history` provisioning in `index create`),
`lib/progress.ts` + `discovery/index.ts` + `progress.test.ts` (§10.4 rename),
`apps/workers/package.json` (`p-queue`), `mise.toml` (`repo:history`), `eslint.config.mjs` only
if a glob needs widening, `AGENTS.md` §0/§4.2/§5/§8, `ROADMAP.md`.

## 13. Definition of done

1. `mise run ci` green.
2. `kecoctl repo crawl --repo argoproj/argo-cd` writes every artifact in AGENTS.md §3's tree
   listing, including a real icon, and appends one `RepoFetched`.
3. Running it a second time emits `RepoFetched{changed:false}` and issues one request.
4. `kecoctl repo history` shows both runs with honest counters.
5. ~~`kecoctl repo crawl --seed cncf,krew --limit 50` completes and `mise run repo:analyze`
   finds candidates.~~ Superseded 2026-09-07: `kecoctl repo crawl --limit 50` completes against
   an existing `discovery_repos` corpus and `mise run repo:analyze` finds candidates.
6. Nothing on the write side reads a read model; `crawl_history` is written only through the
   `DataStore` port.
7. AGENTS.md and ROADMAP.md updated; ADR 0003 committed.
