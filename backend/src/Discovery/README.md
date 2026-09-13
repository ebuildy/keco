# Discovery

Enumerates candidate repos from GitHub Search; it does not fetch them. See `AGENTS.md` §4.1 for
the full contract this bounded context implements — this file is the map of *this directory*,
not a restatement of the business rules.

Using <https://docs.github.com/en/rest/search/search?apiVersion=2026-03-10#search-repositories>

<https://github.com/tomhuang12/awesome-k8s-resources>

## What this context is for, and isn't

- **Produces** `GithubRepository`, `DiscoverySighting`, `DiscoveryRun` and `DiscoveryState` rows.
  Nothing else in `backend/` writes any of these four tables.
- **Does not fetch repos.** The crawler (a separate bounded context, `App\Crawler`) reads
  `GithubRepository` as its worklist and does the actual fetching. Discovery's job ends at "this
  repo exists and matches this query."
- **Appends no `JournalEvent`s.** A weekly sweep touching ~100k repos would otherwise write
  ~100k tiny journal rows for no consumer. The delta is already computed from `payload_hash`.

## Architecture

```
Console/           app:discovery:sweep|count|list|reset — the operator-facing entry points
Message/           SweepDiscoveryQuery — dispatched by Scheduler/cron for the production cadence
MessageHandler/     └─ delegates straight to DiscoverySweepRunner, same as the console command
Search/             GitHubSearchClient + its own RateLimiter-based pacer (SearchPacer)
Store/              DiscoveryStore — all persistence, all upsert/dedup/first-wins logic
Worker/             Clock/SystemClock, Window/Windows/WindowPlan — see below for why this is a
                     sub-namespace of Discovery rather than mixed in directly, or promoted up
DiscoverySweepRunner.php   the orchestration loop — ties the pieces below together
Plan.php, Sweep.php, SweepState.php, QuerySlug.php, Created.php, FailedWindow.php
                     pure algebra that *does* need to know it's discovery-specific
```

**`Window`, `Windows`, `WindowPlan` and the `Clock`/`SystemClock` time abstraction live in
`Discovery/Worker` (`App\Discovery\Worker`)** — grouped apart from the rest of this directory
because they carry no discovery-specific knowledge (calendar-range splitting and "what time is
it" are useful to any future bounded context), but kept as a sub-namespace of `Discovery` rather
than promoted to a top-level `App\Worker`, per AGENTS.md §4/§7's "move it out the moment a second
context needs it, not speculatively": nothing else needs this yet. The day `Crawler` or
`Analyzer` wants the same `Clock` or the same windowing algebra, *that's* the moment to promote
`Discovery/Worker` to a real shared namespace — not before. `Plan`, `Sweep`, `SweepState` and
`QuerySlug` stay directly under `Discovery` because they *do* know they're discovery: `Plan`
decides split-vs-paginate against GitHub Search's 1000-result cap, `Sweep`/`SweepState` are the
resume-vs-new-sweep state machine this context's `DiscoveryState` row persists, `QuerySlug`
derives the slug and composite ids this context's tables key on.

**Two entry points, one implementation.** `DiscoverySweepCommand` (synchronous, for manual runs
and `mise run discovery:sweep`) and `SweepDiscoveryQueryHandler` (async, consumed off the
`async_discovery` Messenger transport for Scheduler-triggered production sweeps) both call
straight into `DiscoverySweepRunner::run()`. Neither has its own copy of the sweep logic.

**The runner is thin by construction.** `DiscoverySweepRunner` is the loop and the signal-handling
wiring (`InterruptHandler`) and nothing else: window algebra is `App\Discovery\Worker\Windows`, the
split/paginate decision is `Plan`, the resume decision is `Sweep`, all persistence is
`DiscoveryStore`. If you find yourself adding business logic to the runner, it probably belongs
in one of those instead.

## Entities

| Entity | Table | Shape |
|---|---|---|
| `GithubRepository` | `github_repositories` | **The unique record of a GitHub repo — one row per repo, globally**, PK is GitHub's own numeric `repo_id`. Latest known snapshot only (name, owner, stars, description, topics, archived/fork, timestamps, its own `payload_hash`). No query provenance. |
| `DiscoverySighting` | `discovery_sightings` | One row per `(query_slug, repo_id)`. `ManyToOne` to `GithubRepository`. Holds `query`, `discoveredVia` (the window that first found it), `discoveredAt`, `firstSeenRunId`, `lastSeenRunId`, and its own `payloadHash` (this query's change signal — a second query might not re-see the repo at the same cadence). |
| `DiscoveryRun` | `discovery_runs` | One row per sweep process. `outcome` is `running`→`complete`\|`failed`\|`interrupted`. Counts (`reposNew`/`reposChanged`/`reposUnchanged`, `pagesFetched`, `dropped`, `windowsCompleted`/`windowsFailed`) are run-scoped, not cumulative. |
| `DiscoveryState` | `discovery_state` | One row per query — the resume position: `pendingWindows`/`completedWindows`/`failedWindows` (json), `currentRunId`, cumulative `reposSeen`/`pagesFetched`/`dropped`. |

**Why the split.** `GithubRepository` used to be keyed by the composite `"{querySlug}_{repoId}"`,
so the same actual repo produced multiple rows if different queries found it — wrong for an
entity whose whole job is to *be* the unique record of a repo (AGENTS.md §4.1). `DiscoverySighting`
reuses that old composite-id scheme, since it's exactly the right shape for "this query's
relationship to this repo." A repo found by two queries is one `GithubRepository` row and two
`DiscoverySighting` rows — proven by `DiscoveryEntitiesTest::testTwoQueriesSightingTheSameRepoShareOneGithubRepositoryRow`.

**Write policy** (`DiscoveryStore::writeCorpus()`): `GithubRepository`'s snapshot is overwritten
with the latest data *regardless of which query saw it*, and skipped only when its own
`payloadHash` is already current. `DiscoverySighting` is first-wins on `discoveredVia`/
`discoveredAt`/`firstSeenRunId`; only `payloadHash`/`lastSeenRunId` refresh on a later sighting.

## Commands

| Command | Flags | Does |
|---|---|---|
| `app:discovery:sweep` | `--query` (default `kubernetes`), `--limit\|-l`, `--fresh` | Enumerates one query into `GithubRepository`/`DiscoverySighting`, resuming from `DiscoveryState` by default. `--fresh` deletes this query's sightings and state and starts over — never another query's, never the run history. `--limit` overshoots to the next window boundary (a dev convenience, not a budget). Exits `1` if any window failed: a truncated corpus must never exit `0`. |
| `app:discovery:count` | `--query`, `--json` | Every query's repo count, run count, pending-window count, and last sweep outcome — one row per swept query (enumerated from `discovery_state`, since a query is "known" from the moment its first sweep opens). |
| `app:discovery:list` | `runs\|repos` (arg, default `runs`), `--query`, `--limit\|-l`, `--sort\|-s`, `--json` | `runs`: the sweep history, newest first by default. `repos`: `GithubRepository` rows, by stars by default — scoped to one query's `DiscoverySighting` join when `--query` is given, otherwise the global corpus. `--sort` only accepts a target's declared sortable fields (`resolveSort()`); anything else is rejected by name rather than silently ignored. |
| `app:discovery:reset` | `--query`, `--all`, `--include-runs`, `--yes\|-y` | Deletes a query's (or every query's) sightings and state; keeps run history unless `--include-runs`. Refuses to run with no target — `--query` or `--all` is required. Prompts unless `--yes`. **Not rebuildable offline**: the next sweep re-queries GitHub Search. |

## Things that will bite you here specifically

- **`--fresh`/`reset` never delete a `GithubRepository` another query still sights.** Both paths
  compute `repoIdsByQuerySlug()` *before* deleting that query's sightings, then call
  `GithubRepositoryRepository::removeOrphans()` with exactly those ids — which only removes rows
  with zero remaining sightings anywhere. Deleting sightings before capturing the id list, or
  skipping the orphan check, silently destroys another query's corpus.
- **DQL bulk deletes bypass the UnitOfWork.** Every reset/fresh path calls `$em->clear()`
  immediately after — an already-managed entity from an earlier `find()` would otherwise keep
  answering from the identity map as if a since-deleted row still existed. This is not optional
  cleanup; a test caught it as a real bug once (see `DiscoveryStore::open()`'s and
  `DiscoveryExplorer::applyReset()`'s docblocks).
- **Flush order is load-bearing.** `DiscoveryStore::flush()` commits the corpus batch, *then* a
  separate, later commit for the `DiscoveryState` row. If the process dies in between, the state
  row hasn't advanced past repos that are already safely written — never the reverse. This is the
  Postgres-transaction-era descendant of the old TS store's "corpus write not awaited, state write
  is" rule (AGENTS.md §4.1) — don't collapse it into one flush "for efficiency."
- **A killed sweep leaves its `DiscoveryRun` at `outcome: running` forever, on purpose.** Only
  `InterruptHandler`'s graceful path (SIGINT/SIGTERM) reaches `finishRun('interrupted')`; a
  SIGKILL reaches nothing. That stuck row is how an operator spots a sweep that died without
  cleanup — a later fix that "cleans up" stale `running` rows would hide exactly the failure this
  is designed to surface.
- **Discovery's rate pacer is its own budget** (`config/packages/rate_limiter.yaml`'s
  `discovery_search`, 1 token / 2 seconds), never shared with the crawler's core-REST quota
  (`GITHUB_QUOTA_CRAWLER_SHARE`). GitHub Search (~30 req/min) and core REST (5000 pts/hr) are
  different limits entirely — don't route a discovery call through anything wired for the other.
- **A window is the unit of retry, not a record.** A failed window is caught, logged, and pushed
  onto `failedWindows` — the sweep continues with the rest of the queue and still exits `1` at the
  end (`AGENTS.md` §13's "a single bad item never aborts a run," applied per-window here since
  discovery has no finer notion of progress than a window).
