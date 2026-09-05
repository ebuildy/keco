# Discovery on a `DataStore` port

**Date:** 2026-08-29
**Status:** approved, not yet implemented
**Supersedes storage decisions in:** `2026-08-02-discovery-worker-design.md`

## 1. Problem

Discovery writes four artifacts to the filesystem cache: `repos-full-list.yaml`, one detail
YAML per repo, `_hashes.json` and `_state.json`. Three consequences drove this change:

1. **There is no history.** A sweep's summary is computed in `runDiscovery`, logged once, and
   lost. Nothing answers "how did last night's sweep go", "how many new repos did we find this
   week", or "how many GitHub Search calls did that cost".
2. **The corpus is not queryable.** 100k detail YAMLs in two-letter buckets can be read by key
   and nothing else.
3. **Storage is hardcoded.** `DiscoveryStore` reaches `@keco/cache` directly, so the substrate
   is not a decision anyone can revisit.

## 2. The distinction this design rests on

AGENTS.md §4 says "the projector is the only writer to Meilisearch" and §2.1 says "the write
side never reads a read model". Both are about **searchable read models** — `tools`, the public
corpus the portal and API query. They are not about the Meilisearch *process*.

AGENTS.md §5 already draws the other half of the line: "`searchableAttributes: []` makes an
index a plain
key-value store … use it for everything that isn't the search corpus."

So there are two usages of one deployed instance:

| Usage | Collections | Owner | Rebuildable offline |
|---|---|---|---|
| Searchable read model | `tools`, `repos_state`, `traces` | projector | yes, from cache, zero network |
| Key-value data store | `discovery_repos`, `discovery_runs`, `discovery_state` | discovery | **no** — only by re-sweeping GitHub |

AGENTS.md §4's rule is restated as **only the projector writes searchable read models**, which
remains
true. Discovery writes write-model data through a storage port, the way it already writes
`repos/**` through `Storage`.

**Workers never learn which backend implements that port.** That is the load-bearing
constraint of this design, and AGENTS.md §7's lint rules enforce it.

## 3. The `DataStore` port

`apps/workers/src/lib/data-store.ts`, beside `runtime.ts` and `config.ts`. No backend
concepts: no tasks, no indexes, no filter syntax.

```ts
export type Document = Record<string, unknown>;

/** Equality only. Deliberately not a query language: anything richer leaks one
 *  backend's filter syntax into every worker that touches the port. */
export type Where = Record<string, string | number | boolean>;

export type CollectionSpec = {
  name: string;
  primaryKey: string;
  /** Fields a `Where` may reference. */
  filterable?: readonly string[];
  /** Fields a `ListQuery.sort` may reference. */
  sortable?: readonly string[];
  /**
   * Fields exposed to full-text search by backends that have one. A provisioning
   * declaration, not a capability the port offers — see "No search operation" below.
   */
  searchable?: readonly string[];
};

export type PutOptions = {
  /**
   * Resolve only when this write AND every earlier write through this handle is durable.
   * The second half is the contract: it is what replaces the fs store's write-ordering
   * guarantee, so a durable state write can never claim work whose corpus write is still
   * in flight.
   */
  durable?: boolean;
};

/** Field + direction. Every field named here must be declared `sortable` on the spec. */
export type Sort = readonly (readonly [field: string, direction: 'asc' | 'desc'])[];

export type ListQuery = {
  where?: Where;
  fields?: readonly string[];
  sort?: Sort;
  /** Stop after N documents. Lets an implementation avoid over-fetching a 100k collection. */
  limit?: number;
};

export interface DataStore {
  /** Idempotent. Called once at startup. */
  ensure(specs: readonly CollectionSpec[]): Promise<void>;
  put(collection: string, documents: readonly Document[], options?: PutOptions): Promise<void>;
  get(collection: string, id: string): Promise<Document | null>;
  /** Cardinality without streaming. `list` cannot serve this: counting 100k documents to
   *  produce one number is exactly what the explore commands (§8) must not do. */
  count(collection: string, where?: Where): Promise<number>;
  /** Pages internally; the caller never sees an offset. */
  list(collection: string, query?: ListQuery): AsyncIterable<Document>;
  remove(collection: string, where: Where): Promise<void>;
}
```

### No search operation

The port cannot search, on purpose. `CollectionSpec.searchable` tells an implementation that
supports full-text to build an index over those fields; the filesystem implementation ignores
it. Discovery only ever calls `get`, `list`, `count`, `put` and `remove`.

The consequence is that `discovery_repos` *is* searchable for a human or the backoffice
querying the index directly, while no worker can express a relevance query. Adding `search()`
to this interface would put a search engine's semantics back into every worker and is the one
change this design exists to prevent.

### Implementations

| File | Used by | Notes |
|---|---|---|
| `lib/data-store.memory.ts` | unit tests | Every discovery test runs with no backend. |
| `lib/data-store.fs.ts` | `DISCOVERY_STORE=fs` | JSON per document through the existing `Storage` port. Preserves offline sweeps and hand-inspectable data. `remove(where)` scans the collection and filters in memory — acceptable for a dev path, and documented as such. |
| `cli/data-store.ts` | production, default | Meilisearch. The only file on discovery's path that imports `@keco/search` — the others are the projector and `handlers.ts`'s two `index` commands, both pre-existing. |

All three run the same conformance suite (§9).

## 4. Composition

`handlers.ts` is already the sanctioned exception in `eslint.config.mjs` — "it holds the admin
client the way engine/cli.ts did". The Meilisearch implementation is wired there, lazily, in the
same shape the two `index` commands already use:

```ts
discoverySweep: async (options) => {
  const { createDataStore } = await import('./data-store');   // the only Meilisearch import
  const { runDiscovery } = await import('../discovery');
  await runDiscovery(options, { dataStore: await createDataStore() });
},
```

`runDiscovery` receives the dependency rather than building it:

```ts
export async function runDiscovery(
  options: DiscoveryOptions,
  deps: { dataStore: DataStore },
): Promise<void>;
```

## 5. Module layout

```
apps/workers/src/lib/
  data-store.ts          port: interface + types, zero backend imports
  data-store.memory.ts   test double
  data-store.fs.ts       Storage-port implementation

apps/workers/src/discovery/store/
  collections.ts         the three CollectionSpecs + document mappers
  store.ts               DiscoveryStore: in-memory maps, flush cadence,
                         first-wins, run bookkeeping. Depends on DataStore only.

apps/workers/src/discovery/
  explore.ts             count / list / reset (§8). DataStore only.

apps/workers/src/cli/
  data-store.ts          Meilisearch implementation
```

Today's `discovery/store.ts` (525 lines doing four jobs) splits into `collections.ts` and
`store.ts`. `toDetail()`, `byPath` and the flush-cadence constants move unchanged —
they are storage-agnostic and always were. `discoveryKeys()` and `legacyDiscoveryStateKey`
are deleted from `packages/cache/src/keys.ts`.

## 6. The three collections

Document ids use `{query_slug}_{id}`: Meilisearch primary keys allow only `[a-zA-Z0-9_-]`, so
no colon. Slugs are alphanumeric-and-hyphen and repo ids are numeric, so the pair cannot
collide.

### `discovery_repos` — the corpus

Searchable. Replaces the detail YAMLs, `repos-full-list.yaml` **and** `_hashes.json`:
`payload_hash` is now a field, so the separate hash index disappears entirely.

Today's `DetailDoc` plus `query`, `query_slug`, `first_seen_run_id`, `last_seen_run_id`.

- `searchable: ['name', 'full_name', 'description', 'topics']`
- `filterable: ['query_slug', 'archived', 'fork', 'language']`
- `sortable: ['stars', 'pushed_at']`

### `discovery_runs` — the history

`searchable: []`. Primary key `run_id`, a ULID, so it sorts by time the way journal keys do.

```ts
{ run_id, query, query_slug,
  started_at, ended_at, duration_ms,
  outcome: 'running' | 'complete' | 'failed' | 'interrupted',
  fresh, limit,
  pages_fetched, dropped,                      // GitHub Search calls, THIS RUN
  repos_new, repos_changed, repos_unchanged,   // this run
  windows_completed, windows_failed,
  sweep_repos_total, sweep_windows_pending, stopped_at_limit,
  failed_windows: [{ window, error }] }        // capped at 50
```

- `filterable: ['query_slug', 'outcome']`
- `sortable: ['started_at', 'duration_ms', 'repos_new', 'pages_fetched']`

Run-scoped counters are derived by snapshotting `state.pages_fetched` and `state.dropped` at
`open()` and subtracting. The `run_` vs `sweep_` distinction the orchestrator already draws in
its summary is preserved, not flattened — reporting "76 pages" when 76 covers two runs is worse
than reporting neither.

### `discovery_state` — resume

`searchable: []`. Primary key `query_slug`, one small document per query: `pending_windows`,
`completed_windows`, `failed_windows`, `repos_seen`, `pages_fetched`, `dropped`, `updated_at`,
`current_run_id`. At ~1000 windows of ~60 bytes this is ~60 KB, well inside a comfortable
document size.

## 7. Behaviour

### Run lifecycle

`open()` writes the run document immediately with `outcome: 'running'`. `finishRun()` stamps
`ended_at`, `duration_ms` and the terminal outcome. The shutdown handler writes `interrupted`.

A `SIGKILL` leaves a run stuck at `running` forever. That is deliberate: it is the honest
signal that a sweep died without cleanup, and a history that quietly rewrote it would hide
exactly the failure someone is looking for.

The orchestrator's local `outcomes` bookkeeping is deleted — `record()` already computes the
outcome, so the store counts it.

### Resume

`open()` streams the corpus to rebuild the in-memory id and hash maps:

```ts
for await (const doc of dataStore.list('discovery_repos', {
  where: { query_slug },
  fields: ['id', 'full_name', 'name', 'payload_hash'],
}))
```

Roughly 100 backend round-trips at 100k repos, once at startup, hidden behind the
`AsyncIterable`. On Meilisearch this is `getDocuments` with offset/limit — AGENTS.md §5's
documented
admin-listing pattern, so the `pagination.maxTotalHits` search cap does not apply.

### `--fresh` gains teeth

Today `--fresh` ignores stored state but leaves the old detail files on disk, which
`store.ts` records as an accepted limitation ("a renamed or transferred repo leaves its old
detail YAML orphaned"). Here it becomes `remove('discovery_repos', { query_slug })` plus a
state delete, so a fresh sweep genuinely starts clean and the orphan problem goes away.

### Durability and write ordering

Today's flush writes list → hashes → state in that order, so state can never claim work the
corpus lacks. That guarantee is preserved through `PutOptions.durable`:

```ts
await dataStore.put('discovery_repos', batch);                  // not awaited for durability
await dataStore.put('discovery_state', [stateDoc], { durable: true });
```

`durable: true` means "this write and every earlier write through this handle". The
Meilisearch implementation keeps the task uids it has enqueued and waits on the whole set with
`client.tasks.waitForTasks(uids)` — one call, assuming nothing about the order the backend
processes tasks in. (An earlier draft awaited only the newest task and then verified the rest,
which quietly rested the corpus-before-state guarantee on Meilisearch's scheduler being FIFO.
It is, today. That is not worth depending on when not depending on it is also free.)

An integration test pins this: enqueue a corpus batch, enqueue a durable state write, assert
the corpus documents are readable the instant the state put resolves.

### The queue-aliasing hazard

`runDiscovery` aliases `state.pending_windows` as its live work queue, and today that is safe
only because `Cache.putJSON` stringifies synchronously before any await. No `DataStore`
implementation may be assumed to do that. **Every implementation must deep-copy
`pending_windows`, `completed_windows` and `failed_windows` into the document before its first
await.** Missing this serialises a half-mutated queue, which loses windows silently.

The conformance suite covers it: mutate the arrays from a `then()` on the in-flight put and
assert the persisted document matches the pre-call snapshot.

## 8. Exploring the dataset

Three operator commands under the existing `discovery` noun. `reset`, not `destroy` — kecoctl
already spends that word in `checkpoint reset`, and inventing a second one for the same idea
makes the CLI harder to guess, not safer.

All three go through `DataStore`, never a backend directly, so they keep working under
`DISCOVERY_STORE=fs`. The logic is `apps/workers/src/discovery/explore.ts`, depending on the
port alone — no new lint exemption, and `handlers.ts` wires the store exactly as it does for
`discoverySweep`.

Results go to **stdout** as a table, or NDJSON under `--json`; pino keeps stderr. That is the
split the progress bar already uses, and it is what makes `--json` pipe into `jq` cleanly. A
query command's output is its result, not a log line.

### `kecoctl discovery count [--query <q>]`

Every collection at once — with no target flag, because a partial answer is not what anyone
opens this for. Grouped by query unless `--query` narrows it.

```
$ kecoctl discovery count
QUERY         REPOS   RUNS   PENDING WINDOWS   LAST SWEEP
kubernetes   31,204     47               118   2026-08-28 03:14  complete
istio           892      6                 0   2026-08-27 22:01  complete
                ---     ---
totals       32,096     53
```

`PENDING WINDOWS` is the number that says whether a sweep finished or is mid-resume, so it
earns a column rather than living behind a flag.

### `kecoctl discovery list [runs|repos] [--query <q>] [--limit N] [--sort <field>] [--json]`

Defaults to `runs`: the history is what this change exists to expose.

```
$ kecoctl discovery list runs --query kubernetes --limit 5
STARTED            DUR    OUTCOME       NEW  CHANGED  PAGES  WINDOWS
2026-08-28 03:14   1h12m  complete    1,204    8,891    742  318/318
2026-08-27 03:14     58m  complete       88    9,102    698  318/318
2026-08-26 11:02      4m  interrupted    12      340     41   18/318
2026-08-25 03:14   1h04m  complete      412    8,770    731  318/318
2026-08-24 03:14      2m  failed          0        0     11    6/318
```

That row is the question the whole change was asked to answer: new projects found, how long it
took, how many GitHub Search calls it cost.

`repos` caps at 20 rows sorted by stars; `--limit` raises it and `--json` streams NDJSON
without buffering the corpus:

```
$ kecoctl discovery list repos --query kubernetes
STARS    REPO                     LANG    PUSHED
112,034  kubernetes/kubernetes    Go      2d ago
 28,901  argoproj/argo-cd         Go      4h ago
…
showing 20 of 31,204 — raise with --limit, or pipe --json
```

`--sort` accepts any field the collection declares `sortable` (§6); anything else is rejected
by name, listing what is available, rather than silently ignored.

### `kecoctl discovery reset (--query <q> | --all) [--include-runs] [--yes]`

Deletes the corpus and resume state, **keeping `discovery_runs`**. The history is the one
collection nothing can reconstruct — not from the cache, not from GitHub — and a reset is
precisely when someone wants to look back at what the previous sweeps did. `--include-runs`
destroys it too, explicitly.

```
$ kecoctl discovery reset --query kubernetes
  discovery_repos   31,204  → delete
  discovery_state        1  → delete
  discovery_runs        47  → keep (--include-runs to delete)

this is not rebuildable offline; the next sweep re-queries GitHub Search
continue? [y/N]
```

Guards, all mandatory:

- **No implicit target.** Without `--query`, the command refuses unless `--all` is passed.
  A reset that defaults to every query is a reset that eventually runs by accident.
- **Confirmation** unless `--yes`, which exists for CI and scripted teardown.
- **The plan prints before the prompt**, with real counts, so the operator confirms against
  what is actually there rather than against what they assumed.

`reset --query X` and `sweep --fresh`'s open-time deletion are the same operation and share one
function — `--fresh` must not drift into meaning something subtly different from `reset`.

## 9. Testing

- **Conformance suite** — one shared suite all three implementations run: put/get round-trip,
  `list` paging and `fields` projection, `where` equality, `sort` direction and `limit`,
  `count` with and without a filter, `remove` by filter, `durable` ordering, and the deep-copy
  requirement above. `count` is asserted against a collection larger than one page, since
  the failure mode is an implementation quietly counting one page.
- **`DiscoveryStore` unit tests** — today's `store.test.ts` (514 lines) re-pointed at the
  in-memory implementation. Record/dedupe/first-wins/resume/flush-cadence assertions carry
  over; the fs-key assertions are replaced by collection assertions.
- **New unit tests** — run-document assembly, run- vs sweep-scoped counter derivation, the
  `running` → `interrupted` transition, `--fresh` deletion.
- **Explore command tests** (§8) — against the in-memory implementation: `count` grouping and
  totals, `list` defaulting to `runs`, the `--sort` rejection path naming the sortable fields,
  the 20-row cap and its "showing N of M" line, `--json` emitting NDJSON. `reset` gets its own
  set, because every one of its guards is a way to not lose data by accident: refusal without
  `--query` or `--all`, the plan printing before the prompt, `--yes` skipping it, run history
  surviving by default, and `--include-runs` removing it.
- **Shared-path test** — `reset --query X` and `sweep --fresh` produce identical deletions.
- **Integration suite** — against the compose Meilisearch: `ensure()` provisioning, resume
  paging at >1000 documents, `--fresh`, `count` over a multi-page collection, and the
  durability ordering test.
- `mise run ci` green.

## 10. Boundaries and tooling

### Lint gets stricter, not looser

Discovery's existing `@keco/search` ban (`eslint.config.mjs:105`) stays exactly as written — no
exemption is needed, because discovery never imports it. Two tightenings:

- add `apps/workers/src/lib/**/*.ts` to that ban, so the port cannot grow a backend import
- narrow the CLI rule from two named files to `apps/workers/src/cli/**`, with `handlers.ts`
  and `data-store.ts` as the listed exceptions, so a future `cli/*.ts` is not unbounded by
  default

### `infra:reset` is guarded

`mise run infra:reset` means "wipe the read model; rebuild offline in minutes with zero GitHub
calls". That is no longer the whole truth: it now also destroys discovery's write model, which
is **not** rebuildable offline — only by re-sweeping GitHub Search, which is hours of paced
requests.

The task grows a preflight that reports what it is about to destroy and requires confirmation,
with `--yes` for CI. It calls the same function behind `kecoctl discovery count` (§8) rather
than re-deriving the numbers, so the two can never disagree about what is on disk:

```
$ mise run infra:reset
this destroys discovery write-model data that is NOT rebuildable offline:
  kubernetes  31,204 repos, 118 windows pending
  istio          892 repos, sweep complete
continue? [y/N]
```

### Config

`DISCOVERY_STORE=meili|fs|memory`, default `meili`. `MEILI_HOST` and `MEILI_MASTER_KEY` already
exist in `apps/workers/src/lib/config.ts`. `ulid` is added to `apps/workers` dependencies.

`kecoctl index create` provisions the three discovery collections alongside `tools`, so a
deployment bootstrap covers both usages in one step.

Every dev script is a mise task (§8 of AGENTS.md), so the three explore commands get
`discovery:count`, `discovery:list` and `discovery:reset` alongside the existing
`discovery:sweep`.

### Documentation

- `docs/adr/0002-discovery-datastore.md` — records §2's distinction, the port, and the
  `infra:reset` consequence.
- AGENTS.md §3 (discovery is no longer under `.cache/`), §4 and §4.1 (the `DataStore`
  dependency and the run history), §5 (the two usages table), §7 (module layout and the
  tightened lint rules), §8 (the three new commands and the guarded `infra:reset`), §14 (the
  queue-aliasing hazard).

## 11. Out of scope

**The projector is not migrated.** Its job is defined as writing the searchable read model,
and it needs alias swaps, count-verified promotion and rebuild-index creation — none of which
`DataStore` models, and modelling them would drag those concepts into the port. If it ever
moves, that is a separate change.

**Nothing else moves.** `repos/**`, `analysis/**`, the journal and checkpoints stay on the
`Storage` port. The crawler's contract is unchanged in kind: it reads discovery's output, which
is now a collection rather than a YAML file. That wiring does not exist yet either way.
