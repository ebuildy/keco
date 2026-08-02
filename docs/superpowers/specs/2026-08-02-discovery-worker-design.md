# Discovery worker — design

Date: 2026-08-02
Status: designed, not implemented

## Problem

The crawler stub in `apps/workers/src/crawler/index.ts` has to do two unrelated jobs before it
can do anything useful: find out which repositories exist, and fetch what is inside them. The
first job has its own rate-limit budget (GitHub Search: ~30 req/min, capped at 1000 results per
query), its own failure modes and its own runtime — a cold sweep takes one to two hours, which
is a different operational shape from fetching a known list of repos.

Splitting discovery out gives each half one clear purpose, and makes the slow half resumable on
its own terms.

## Scope

A **discovery worker** that enumerates GitHub repositories matching a keyword (default:
`kubernetes`) across the whole corpus, not just the first 1000, and writes two artifacts:

- `repos-full-list.yaml` — a flat array of `{ id, path, name }`.
- one detail file per repo, in a two-letter bucket hierarchy.

Out of scope, and deliberately so:

- **Skip rules.** Forks, archived-and-stale, CI-manifest-only — these belong to the crawler
  (AGENTS.md §4.1). Discovery reports what matches; it does not judge.
- **Registry seeds.** CNCF landscape, krew, Artifact Hub. Still the crawler's, still §4.1.
- **Fetching README, tree, releases, manifests.** The crawler's, via the verbatim JSON cache.

## Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Coverage | sharded windows, subdivided on demand, full corpus | single query capped at 1000; fully static window ladder |
| Output location | `discovery/` prefix in the cache, via the `Storage` port | plain fs directory outside the cache; replacing `repos/**` JSON with YAML |
| Bucket naming | by owner, `owner__repo` filename | by repo name; real `owner/repo` nesting under buckets |
| Journal events | none | `RepoDiscovered` per repo per run; `RepoDiscovered` for new repos only |
| Rewrite policy | only when the payload hash changed | always rewrite |
| Detail YAML shape | curated projection | verbatim search item |

Two of these depart from AGENTS.md and are recorded here so the departure is deliberate rather
than discovered later:

**No journal events (§2, §3).** Every other worker communicates through the journal, and the
contract says the crawler consumes `RepoDiscovered`. Discovery instead publishes a file the
crawler reads directly. The cost: the crawler cannot resume from an event offset for discovery
input, and discovery output is a snapshot rather than a stream. The benefit: a weekly sweep does
not write ~100k tiny journal files, and the artifact is directly inspectable. If the crawler
later needs incremental input, the delta is already computed — `_hashes.json` knows exactly which
repos are new or changed, so emitting events becomes a small additive change.

**Curated detail YAML, not verbatim (§3).** "Verbatim means verbatim" exists so a parser bug is
fixed by re-analyzing rather than re-crawling. It holds here because nothing downstream depends
on this file for classification: the crawler independently fetches and stores
`repos/{owner}/{repo}/repo.json` verbatim, and that is what the analyzer reads. The discovery
detail file is a human- and crawler-readable index entry, and the ~80 URL-template fields of a
raw search item (`assignees_url`, `archive_url`, …) would bury its content.

## Architecture

A fourth worker under `apps/workers/src/discovery/`, sitting before the crawler in the pipeline.
It is the only component that calls GitHub Search.

```
GitHub Search ─┬─▶ dedup by repo id (in-memory Set)
               │
               ├─▶ full list  (Map<id, {id,path,name}>, flushed periodically + at end)
               │
               └─▶ per repo: hash the curated payload
                     ├── hash unchanged ──▶ skip write
                     └── new or changed ──▶ write bucket YAML, update _hashes
```

Four modules. The three pure ones carry the logic and are unit-tested without a network;
`index.ts` stays thin orchestration.

| Module | Responsibility | Depends on |
|---|---|---|
| `windows.ts` | build the initial band list; split one window into sub-windows | nothing (pure) |
| `naming.ts` | encode `owner/repo` into a bucket path | nothing (pure) |
| `store.ts` | read/write the YAML artifacts, hashes, resume state | `@keco/cache` |
| `index.ts` | CLI, orchestration loop, progress reporting | all of the above |

Supporting changes elsewhere:

| File | Change |
|---|---|
| `packages/github/src/search.ts` | new — search client, own rate pacer, backoff |
| `apps/workers/src/lib/progress.ts` | new — TTY progress bar / non-TTY periodic logging |
| `packages/cache/src/keys.ts` | add `discoveryKeys` |
| `eslint.config.mjs` | add `discovery/**` to the no-`@keco/search` boundary |
| `mise.toml`, `apps/workers/package.json` | `mise run discovery` task and script |

## Cache layout

Everything goes through the `Storage` port — no `fs` calls, no `path.join` outside
`packages/cache` (§14).

```
discovery/
├── repos-full-list.yaml                      # array of { id, path, name }
├── a/h/repo-details-ahmetb__kubectx.yaml
├── k/u/repo-details-kubernetes-sigs__krew.yaml
├── _hashes.json                              # { "owner/repo": "<payload_hash>" }
└── _state.json                               # resume point
```

`_hashes.json` is what makes change-gating cheap. Delta detection becomes an in-memory map
lookup after a single read; the alternative — re-reading and re-parsing 100k YAML files each
sweep — would cost more than the writes it avoids. It also keeps `repos-full-list.yaml` to the
three fields specified, with no hash column leaking in.

At ~100k repos, `_hashes.json` is roughly 5 MB and the in-memory full-list map roughly 6 MB.
Both are read once at start and rewritten in full at each flush point. A flush point is the
completion of a window — the same moment `_state.json` advances — so the three files always
agree with each other after a kill.

## Reaching the whole corpus

GitHub Search caps every query at 1000 results, so pagination alone reaches 1000 repos out of a
corpus in the hundreds of thousands. Windows subdivide on demand:

```
process(window):
  page 1 (per_page=100)  ->  total_count AND the first 100 items
  if total_count <= 1000:  paginate to exhaustion; done
  if total_count >  1000:  keep those 100 anyway (dedup absorbs them),
                           split the window and recurse into each part
```

The probe request is not wasted: it returns both the count that drives the decision and 100 real
results.

Split order, coarse to fine:

1. `stars:` band — `>5000`, `1000..4999`, `500..999`, `200..499`, `100..199`, `50..99`,
   `20..49`, `10..19`, `5..9`, `3..4`, `2`, `1`, `0`
2. `created:` year
3. quarter
4. month
5. day

Dense low-star bands descend several levels; `stars:>5000` resolves in a single window. A window
still over 1000 at day granularity is logged as a warning carrying its `total_count` and
truncated at 1000 — visible in the logs, never silent.

Expected cost: roughly 1500–3500 search requests, at 30 req/min, so **one to two hours** for a
cold full sweep. That is why resume state and the progress bar are load-bearing here rather than
cosmetic.

### Rate limiting

GitHub Search has its own budget, separate from the 5000 points/hour REST budget that
`QuotaGovernor` splits between crawler and analyzer (§4.2). `packages/github/src/search.ts`
therefore carries its own pacer and does not touch `QuotaGovernor`. It reuses the existing
`backoffMs` helper for 403/429 and honours `retry-after`.

## Detail document

```yaml
id: 20038725
full_name: ahmetb/kubectx
name: kubectx
owner: ahmetb
description: Faster way to switch between clusters and namespaces in kubectl
homepage: https://kubectx.dev
stars: 18234
forks: 1180
open_issues: 41
language: Go
license: Apache-2.0
topics: [kubernetes, kubectl, kubectx]
archived: false
fork: false
default_branch: master
created_at: 2014-05-22T12:00:00Z
updated_at: 2026-07-20T08:11:00Z
pushed_at: 2026-07-14T19:02:00Z
discovered_via: "kubernetes stars:>5000"
discovered_at: 2026-08-02T09:30:00Z
payload_hash: 3f2a9c1e...
```

`payload_hash` covers every field above **except** `discovered_at` and `payload_hash` itself.
Including `discovered_at` would make every file look changed on every run, defeating the whole
rewrite policy.

`discovered_via` records the window that found the repo. When a repo is found by more than one
window, the first one wins — deduplication is by repo id and later sightings are dropped, so
the value is stable across a run.

## Naming

`naming.ts`, pure and unit-tested:

1. lowercase the owner
2. bucket = first character, then second character; pad with `_` when the owner is shorter
3. filename = `repo-details-{owner}__{repo}.yaml`, with `/` replaced by `__`

| Input | Path |
|---|---|
| `ahmetb/kubectx` | `discovery/a/h/repo-details-ahmetb__kubectx.yaml` |
| `kubernetes-sigs/krew` | `discovery/k/u/repo-details-kubernetes-sigs__krew.yaml` |
| `x/y` | `discovery/x/_/repo-details-x__y.yaml` |
| `Foo/Bar` | `discovery/f/o/repo-details-Foo__Bar.yaml` |

Only the bucket letters are lowercased; the filename preserves the real casing of `owner/repo`,
because GitHub names are case-sensitive in principle and two repos differing only by case must
not collide. On a case-insensitive filesystem (macOS default) they would collide anyway — an
accepted limitation, noted rather than engineered around, since such pairs are vanishingly rare
in practice and neither name would be lost from `repos-full-list.yaml`.

## Resume and failure

`_state.json` holds the resume point:

```json
{
  "query": "kubernetes",
  "started_at": "2026-08-02T09:30:00Z",
  "completed_windows": ["kubernetes stars:>5000", "..."],
  "failed_windows": [{ "window": "...", "error": "..." }],
  "repos_seen": 42904,
  "requests": 2140
}
```

- State is flushed after each **completed** window. A kill mid-sweep resumes at the next window,
  not from the beginning.
- A window that still fails after backoff and retries is recorded in `failed_windows` and the run
  continues — one bad window never aborts a sweep (§13).
- `--fresh` ignores existing state and starts over. Default is resume.
- Resuming with a different `--query` than the one in state is treated as a fresh run, since the
  completed-window list means nothing for a different query.

Because writes are keyed and idempotent, reprocessing a window on resume produces the same
result: the repo is already in the hash map, so its detail file is skipped.

## Progress reporting

`apps/workers/src/lib/progress.ts`, hand-rolled, no new dependency.

- Renders to **stderr**, and only when `stderr.isTTY`. Pino writes JSON to stdout, so the two
  never collide and `mise run discovery > out.log` stays parseable.
- Non-TTY (CI, piped) falls back to a periodic pino info line, keeping CI logs readable rather
  than filling them with redraw escape sequences.
- The total is not known up front, since window counts are discovered by probing. The bar tracks
  windows completed against windows currently known, and reports repos found as a running count.
  The denominator therefore grows as subdivision uncovers more windows, and the eta is best
  effort — extrapolated from the observed request rate, not a promise.

```
discovering  [##############··········]  42,904 repos · window 187/301 · 2,140 req · eta 38m
```

## CLI

```
mise run discovery -- [--query kubernetes] [--limit N] [--fresh]
```

| Flag | Default | Meaning |
|---|---|---|
| `--query` | `kubernetes` | base search query |
| `--limit` | none | stop once the full list holds N repos; for dev runs |
| `--fresh` | off | ignore resume state and start over |

`--limit` is measured against the total size of the full list, not against repos found in the
current run. Resuming a run that already has 500 repos with `--limit 500` therefore stops
immediately rather than adding 500 more. The stop is checked at window boundaries, so the final
count can overshoot slightly — a window is always finished once started, which keeps
`completed_windows` truthful.

`GITHUB_TOKEN` is required. Unauthenticated search is 10 req/min, which turns a two-hour sweep
into a six-hour one; the worker exits with a clear error rather than starting.

## Testing

| Test | Covers |
|---|---|
| `windows.test.ts` | star bands are contiguous with no gaps or overlaps; subdivision descends year→quarter→month→day; a day-level window over 1000 yields a warning rather than infinite recursion |
| `naming.test.ts` | the table above, plus single-char owners, uppercase, leading digits, dots and hyphens |
| `store.test.ts` | round-trip of the full list and detail YAML; unchanged hash skips the write; changed hash rewrites; state flush and resume |
| `search.test.ts` | pagination to exhaustion; 403/429 backoff honours `retry-after`; the pacer holds to 30 req/min |
| `progress.test.ts` | non-TTY emits log lines and no escape codes; TTY renders a bar |

Tests use a stub `Storage` and a stubbed search client — no network, per §15.

## Definition of done

1. `mise run ci` green (check, lint, test, taxonomy:check).
2. `mise run discovery -- --limit 500` produces a well-formed `repos-full-list.yaml` and the
   matching bucket tree, from a cold cache.
3. Re-running the same command writes zero detail files and reports every repo as unchanged.
4. Killing a run mid-sweep and restarting resumes at the next window, with no duplicate entries
   in the full list.
5. No `fs` access outside `packages/cache`; everything through the `Storage` port.
6. Nothing on the read side is touched; discovery writes only under `discovery/`.
