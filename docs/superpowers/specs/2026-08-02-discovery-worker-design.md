# Discovery worker — design

Date: 2026-08-02
Status: implemented on `feat/discovery-worker`

> **This document has been reconciled against the implementation.** Where review found the
> original design wrong, the design text was corrected and the reason recorded inline —
> see "Corrections found during implementation" at the end.

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

The pure modules carry the logic and are unit-tested without a network; `index.ts` stays thin
orchestration. Path construction lives in `packages/cache`, not here (§14).

| Module | Responsibility | Depends on |
|---|---|---|
| `windows.ts` | build the initial band list; split one window into sub-windows | nothing (pure) |
| `plan.ts` | decide split vs paginate for one probed window | `windows.ts` (pure) |
| `sweep.ts` | the resume-vs-new-sweep state transition | nothing (pure) |
| `store.ts` | read/write the YAML artifacts, hashes, resume state | `@keco/cache` |
| `index.ts` | CLI, orchestration loop, progress, signals | all of the above |

`plan.ts` and `sweep.ts` were extracted during review rather than designed up front. Both hold
decisions that had originally been inlined in the loop, where `index.ts` executes on import and
nothing is reachable by a test — and both turned out to contain a real bug. The lesson is
recorded here because it generalises: logic that cannot be tested in place should be moved
until it can be.

Supporting changes elsewhere:

| File | Change |
|---|---|
| `packages/github/src/search.ts` | new — search client, own rate pacer, retry policy |
| `apps/workers/src/lib/progress.ts` | new — TTY progress bar / non-TTY periodic logging |
| `apps/workers/src/lib/shutdown.ts` | new — signal handling with the grace window |
| `packages/cache/src/keys.ts` | add `discoveryKeys(query)` |
| `packages/cache/src/adapters/fs.ts` | `put` made atomic (write-then-rename) |
| `packages/cache/src/storage.ts` | document the atomicity guarantee on the port |
| `eslint.config.mjs` | add `discovery/**` to the no-`@keco/search` boundary |
| `mise.toml`, `apps/workers/package.json` | `mise run discovery` task and script |

## Cache layout

Everything goes through the `Storage` port — no `fs` calls, no `path.join` outside
`packages/cache` (§14).

Artifacts are namespaced per query, so two keywords coexist in one cache:

```
discovery/{query}/
├── repos-full-list.yaml                      # array of { id, path, name }
├── a/h/repo-details-ahmetb__kubectx.yaml
├── k/u/repo-details-kubernetes-sigs__krew.yaml
├── _hashes.json                              # { "owner/repo": "<payload_hash>" }
└── _state.json                               # resume point
```

`{query}` is a slug: lowercased, non-alphanumeric runs collapsed to `-`, trimmed, capped at
100 characters, and rejected outright if it slugifies to empty. That makes it a single flat
path segment, so a query can never traverse — `k8s/../../etc/passwd` becomes
`k8s-etc-passwd`, and `..` throws. The slug is lossy and two spellings can collide
(`kubernetes operator` and `kubernetes-operator` share a namespace); that is accepted, since
colliding pairs are near-identical searches whose union is still a valid corpus, and
unguessable hash-suffixed directory names would be worse for a cache humans inspect by hand.

`_hashes.json` is what makes change-gating cheap. Delta detection becomes an in-memory map
lookup after a single read; the alternative — re-reading and re-parsing 100k YAML files each
sweep — would cost more than the writes it avoids. It also keeps `repos-full-list.yaml` to the
three fields specified, with no hash column leaking in.

At ~100k repos, `_hashes.json` is roughly 5 MB on disk and the two in-memory maps about 55 MB
of heap. Both are read once at start and rewritten in full at each flush point.

**Flushing is interval-based, not per-window.** A full flush at 100k entries was measured at
~950 ms and 10.9 MB, dominated by YAML serialisation. Running that after every window is up to
a 50 % wall-clock tax on a cheap single-page window, and it worsens as the corpus grows —
several GB written and 5–15 minutes of pure serialisation over a sweep. So a flush happens when
either **25 windows** have completed or **30 seconds** have elapsed, whichever comes first, plus
unconditionally when the sweep ends, throws, or is interrupted. The bounded cost is re-running
up to 30 s of windows on resume, far cheaper than the flushes it saves.

**Every write is atomic.** `Storage.put` writes to a sibling temp key and `rename`s onto the
target, which is atomic on POSIX within a filesystem. This is not optional polish: `yaml.parse`
never throws on a truncated list — it returns partial data, which would then be written back,
silently and permanently deleting corpus entries. The guarantee is documented on the `Storage`
port because callers now depend on it, and it matches what object storage provides natively, so
the eventual S3 adapter needs no new behaviour.

Ordering within a flush is list → hashes → state, and `_state.json` is therefore the **commit
point**: a window is only ever recorded complete after its repos are durable. The reverse order
loses repos, which a test pins by asserting a resume after a mid-flush failure.

Everything loaded from disk is validated with zod, including `pending_windows`, which is fed
straight back into the window algebra. Unusable state warns and starts a fresh sweep rather
than throwing — a wedged worker needing a manual `rm` is worse than a re-sweep.

## Reaching the whole corpus

GitHub Search caps every query at 1000 results, so pagination alone reaches 1000 repos out of a
corpus in the hundreds of thousands. Windows subdivide on demand:

```
process(window):
  page 1 (per_page=100)  ->  total_count AND the first 100 items
  if total_count <= 1000:  paginate to exhaustion; done
  if total_count >  1000 and the window can still be split:
                           keep those 100 anyway (dedup absorbs them),
                           split the window and recurse into each part
  if total_count >  1000 and the window is a single day (unsplittable):
                           paginate to the 1000-result ceiling and mark it truncated
```

The probe request is not wasted: it returns both the count that drives the decision and 100 real
results.

That last branch matters more than it looks. An earlier version split-or-truncated on the same
path, so an unsplittable day kept only the 100 probe results and discarded the other 900
reachable ones — on precisely the densest days in the corpus.

Split order, coarse to fine:

1. `stars:` band — `>5000`, `1000..5000`, `500..999`, `200..499`, `100..199`, `50..99`,
   `20..49`, `10..19`, `5..9`, `3..4`, `2`, `1`, `0`
2. `created:` — a single pre-2014 bucket (`2008-01-01..2013-12-31`), then one window per
   calendar year
3. quarter
4. month
5. day

The bands must tile `[0, ∞)` exactly, and a test asserts it. The boundary between the top two
is subtle and was originally wrong here: measured against the live API, `stars:>5000` is
**strictly** exclusive and `A..B` is inclusive at both ends, so `1000..5000` is contiguous with
`>5000`. The `1000..4999` this document first specified would have silently dropped every repo
sitting at exactly 5000 stars.

Boundaries are calendar-aligned rather than bisected, and that is load-bearing: a resumed sweep
matches completed windows by query string, so bounds that shifted with the current date would
invalidate every resume.

Repos created before 2008 are unreachable by a date-split window. Measured: that is exactly one
repository — `mojombo/grit`, repo id 1, from GitHub's private beta — and it is not a Kubernetes
tool.

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

`payload_hash` covers every field above **except** `discovered_at`, `discovered_via`, and
`payload_hash` itself.

- `discovered_at` would make every file look changed on every run, defeating the rewrite policy.
- `discovered_via` is provenance rather than content, and it is *unstable by construction*: a
  window over 1000 results contributes its 100 probe items under the parent's query and then
  subdivides, so a child re-sees those same repos under a different query. With it in the hash,
  an interrupted-then-resumed sweep rewrote 100 documents on a 3000-repo corpus for no reason —
  tens of thousands of pointless writes at real scale. Excluding it makes the documented
  first-wins rule actually hold: the stored value is the first sighting's window and is
  deliberately never updated.

`stars` **is** in the hash, unlike `contentHash` in `@keco/cache`, which excludes it so star
churn cannot trigger expensive re-analysis. Here the star count *is* the content, so excluding
it would leave a document asserting a number the search no longer reports. The consequence is
that a weekly sweep rewrites most documents rather than a few hundred — correct behaviour, and
the reason the skip mostly pays off on same-day re-runs and on resumes.

## Naming

Bucket paths live in `packages/cache/src/keys.ts` alongside every other write-model key, not in
the worker — §14 names `path.join` outside `packages/cache` as a thing that has to be undone
when the S3 adapter lands. `discoveryKeys(query)` is a factory so the query slug is computed and
validated exactly once per store, before any I/O.

1. lowercase the owner
2. bucket = first character, then second character; pad with `_` when the owner is shorter, and
   substitute `_` for any character that is unsafe as a directory name
3. filename = `repo-details-{owner}__{repo}.yaml`, with `/` replaced by `__`

| Input | Path (under `discovery/{query}/`) |
|---|---|
| `ahmetb/kubectx` | `a/h/repo-details-ahmetb__kubectx.yaml` |
| `kubernetes-sigs/krew` | `k/u/repo-details-kubernetes-sigs__krew.yaml` |
| `x/y` | `x/_/repo-details-x__y.yaml` |
| `Foo/Bar` | `f/o/repo-details-Foo__Bar.yaml` |
| `.github/example` | `_/g/repo-details-.github__example.yaml` |

`detail()` rejects anything that is not exactly `owner/repo` — including multi-slash input,
which would otherwise embed a directory separator in what must be a leaf filename and silently
break the one-file-per-repo invariant.

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
  "pending_windows": [{ "base": "kubernetes", "stars": "0", "created": { "kind": "year", "year": 2021 } }],
  "completed_windows": ["kubernetes stars:>5000", "..."],
  "failed_windows": [{ "window": "...", "error": "..." }],
  "repos_seen": 42904,
  "sweep_pages_fetched": 2140,
  "dropped": 0
}
```

- `pending_windows` is the live queue, serialised. Without it a resume loses every window
  produced by subdivision: the parent is recorded complete and its children existed only in
  memory.
- An empty `pending_windows` means the last sweep finished, so the next run starts a **new**
  sweep: `completed_windows` and `failed_windows` reset while the repo list and hashes carry
  over. Without that reset a second run would skip every window and do nothing.
- A window is only removed from the queue *after* it is recorded complete or failed — peek, then
  shift. Shifting first leaves an interrupted in-flight window in neither list, silently dropping
  it from the sweep.
- A window that still fails after backoff and retries is recorded in `failed_windows` and the run
  continues — one bad window never aborts a sweep (§13) — but the run then exits **1** and logs
  at error level, because a truncated corpus reported as success is worse than a loud failure.
- `--fresh` starts this query's sweep over. It is scoped to the query's own namespace, so it
  cannot touch a sibling corpus.
- `sweep_pages_fetched` counts pages, not HTTP requests: the search client retries internally, so
  it is a floor. `dropped` counts items that failed per-item validation, surfaced rather than
  silently discarded (§13).

Because writes are keyed and idempotent, reprocessing a window on resume produces the same
result: the repo is already in the hash map, so its detail file is skipped.

### Interruption

A sweep must survive Ctrl-C. Two things are needed, and the second is not obvious:

1. A **grace window**. A terminal Ctrl-C signals the whole process group, and the process manager
   then sends SIGTERM shortly after. Without a grace period the second signal re-enters the
   handler, sees a shutdown already running, and aborts the in-flight flush. Signals arriving
   within ~1 s of the first are therefore ignored.
2. **No supervising parent.** The `tsx` CLI spawns the real process as a child and tears it down
   ~110 ms after a group signal — faster than a 100k flush can complete, so no handler can win
   under it. The worker runs as `node --import tsx` (a loader, one process) so the signal reaches
   its own handler. Reverting that silently reintroduces the data loss.

Verified by signalling the process group through the real `mise`/`pnpm` chain: all three
artifacts land and agree, with no orphaned temp files. A control run with the grace window
disabled loses the flush.

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

The worker takes **no positional arguments** and rejects them with a message naming the cause.
This exists because `pnpm -F @keco/workers discovery -- --limit 5` forwards the `--` verbatim,
and `node:util`'s `parseArgs` puts everything after a bare `--` into positionals — so the flag
would be silently ignored and a full sweep would start. `mise run discovery -- --limit 5` is
unaffected, because mise appends arguments without the separator. The other workers share this
latent hazard and are untouched.

## Testing

| Test | Covers |
|---|---|
| `keys.test.ts` | bucket paths, per-query namespacing, query slugification including hostile input (`..`, `a/b`, empty, unicode, over-long) |
| `windows.test.ts` | star bands tile `[0, ∞)`; a property test that subdivision partitions its parent exactly at every level; every rendered endpoint is a real calendar date; window identity is date-independent |
| `store.test.ts` | full-list and detail round-trip; unchanged hash skips; changed hash rewrites; degrade-on-load for every corrupt artifact; flush cadence; flush crash-safety pinned against a reversed write order; two queries coexist |
| `search.test.ts` | pagination; throttle vs transient retry classes; `retry-after` and `x-ratelimit-reset`; the 60 s throttle floor and 300 s ceiling; pacer spacing and penalty persistence; item-level parse resilience |
| `plan.test.ts` | the split-vs-paginate decision, including the unsplittable-day case and `lastPage * perPage <= 1000` across page sizes |
| `sweep.test.ts` | resume-vs-new-sweep state transition |
| `shutdown.test.ts` | a SIGTERM 20 ms after SIGINT must not abort the flush |
| `progress.test.ts` | non-TTY emits log lines and no escape codes; TTY renders a bar |
| `fs.test.ts` | `put` is atomic — a key is fully replaced or left intact |

Tests use a real temp directory with `FsStorage` and a stubbed search transport — no network,
per §15.

The `windows` property tests exist because example-based tests were provably insufficient:
three separate gap-producing mutations (a wrong month offset for Q2–Q4, a 30-day cap, a
hardcoded leap year) all passed the original suite while silently deleting thousands of days
from the corpus.

## Definition of done

1. `mise run ci` green (check, lint, test, taxonomy:check).
2. `mise run discovery -- --limit 500` produces a well-formed `repos-full-list.yaml` and the
   matching bucket tree, from a cold cache.
3. Re-running the same command writes zero detail files and reports every repo as unchanged.
4. Killing a run mid-sweep and restarting resumes at the next window, with no duplicate entries
   in the full list.
5. No `fs` access outside `packages/cache`; everything through the `Storage` port.
6. Nothing on the read side is touched; discovery writes only under `discovery/{query}/`.

Items 1 and 3–6 are verified. **Item 2 is not: no run against the real GitHub API has been
made**, because no `GITHUB_TOKEN` was available. Everything to date is verified against a
stubbed transport, so the real response shape, live throttling behaviour, and actual
`total_count` distributions remain unconfirmed.

## Corrections found during implementation

Recorded because each was a defect in this document, not in the code written from it.

| Correction | Consequence had it shipped |
|---|---|
| `1000..4999` → `1000..5000` | Every repo at exactly 5000 stars silently missing; `stars:>5000` is strictly exclusive, measured against the live API |
| Unsplittable day now paginates to 1000 | 900 of 1000 reachable repos discarded on the densest days |
| `pending_windows` persisted | A resume lost every window produced by subdivision |
| Writes made atomic | A torn `repos-full-list.yaml` silently deleted corpus entries, since `yaml.parse` returns partial data rather than throwing |
| Flush moved to an interval | ~950 ms / 10.9 MB per window at 100k, a ~50 % tax on cheap windows |
| `discovered_via` removed from the hash | Tens of thousands of pointless rewrites per resume |
| Grace window + `node --import tsx` | Ctrl-C discarded the entire sweep |
| Failed windows set exit 1 | A truncated corpus reported as success |
| Per-query namespacing | `--query istio` destroyed a `kubernetes` corpus |
| `--limit` counted against the full list | — (clarification only) |

Two naming deviations from the newer architecture document remain, deliberately: this
implementation uses `_state.json` and `_hashes.json` rather than `state.json`, because the
leading underscore separates machine bookkeeping from the letter-bucket directories beside it,
and `_hashes.json` has no counterpart in that document. The detail layout is one file per repo,
not `{window}.yaml`.
