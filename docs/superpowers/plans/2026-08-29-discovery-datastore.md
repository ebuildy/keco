# Discovery on a `DataStore` port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move discovery's write model off the filesystem cache behind a `DataStore` port that no worker can see the backend of, and add a queryable per-run history plus three commands to explore it.

**Architecture:** A backend-neutral `DataStore` interface lives in `apps/workers/src/lib`. Three implementations satisfy one shared conformance suite: in-memory (tests), filesystem (offline, via the existing `Storage` port), and Meilisearch. Only `apps/workers/src/cli/data-store.ts` imports `@keco/search` — workers depend on the interface alone. Discovery's corpus, resume state and run history become three collections.

**Tech Stack:** TypeScript (ESM, `strict`), Node 24, pnpm workspaces, vitest, commander, zod, pino, Meilisearch, mise.

**Spec:** [`docs/superpowers/specs/2026-08-29-discovery-datastore-design.md`](../specs/2026-08-29-discovery-datastore-design.md)

---

## Phases

| Phase | Tasks | Produces |
|---|---|---|
| 1 — The port | 1–5 | `DataStore` + three implementations, all passing one conformance suite |
| 2 — Discovery data | 6–9 | Collections, mappers, `DiscoveryStore` rewritten over the port |
| 3 — Wiring | 10–11 | `runDiscovery` takes the dependency; `kecoctl discovery sweep` works end to end |
| 4 — Explore | 12–16 | `discovery count` / `list` / `reset` |
| 5 — Tooling & docs | 17–20 | Lint, mise, `infra:reset` guard, ADR, AGENTS.md |

**Phase 4 is independently deferrable.** Phases 1–3 and 5 leave the system working; Phase 4 only adds commands.

## File structure

**Create:**

| File | Responsibility |
|---|---|
| `apps/workers/src/lib/data-store.ts` | The port: types, interface, and the pure `where`/`sort`/`fields` helpers every implementation shares. No backend imports, ever. |
| `apps/workers/src/lib/data-store.conformance.ts` | One suite all three implementations run. Not a `.test.ts` — it is imported by them. |
| `apps/workers/src/lib/data-store.memory.ts` | In-memory implementation. The test double. |
| `apps/workers/src/lib/data-store.memory.test.ts` | Runs the conformance suite. |
| `apps/workers/src/lib/data-store.fs.ts` | Filesystem implementation over the `Storage` port. |
| `apps/workers/src/lib/data-store.fs.test.ts` | Runs the conformance suite. |
| `apps/workers/src/cli/data-store.ts` | Meilisearch implementation + `createDataStore()`. The only file here importing `@keco/search`. |
| `apps/workers/src/cli/data-store.test.ts` | Unit tests for the parts that need no server (spec→settings mapping, id validation). |
| `apps/workers/src/cli/data-store.integration.test.ts` | Conformance suite + durability ordering against the compose Meilisearch. |
| `apps/workers/src/discovery/store/collections.ts` | The three `CollectionSpec`s, `slugifyQuery`, document ids, and every mapper. Pure. |
| `apps/workers/src/discovery/store/collections.test.ts` | Mapper and slug tests. |
| `apps/workers/src/discovery/store/schemas.ts` | zod schemas for every document read back out of the port. |
| `apps/workers/src/discovery/store/schemas.test.ts` | Degradation paths — bad window kinds, back-filled counters. |
| `apps/workers/src/discovery/store/store.ts` | `DiscoveryStore`: in-memory maps, first-wins, flush cadence, run bookkeeping. `DataStore` only. |
| `apps/workers/src/discovery/store/store.test.ts` | Today's suite, re-pointed at the in-memory store. |
| `apps/workers/src/discovery/explore.ts` | `count` / `list` / `reset` data access. `DataStore` only. |
| `apps/workers/src/discovery/explore.test.ts` | Aggregation, reset planning, every guard. |
| `apps/workers/src/discovery/explore-format.ts` | Pure rendering: tables and NDJSON. |
| `apps/workers/src/discovery/explore-format.test.ts` | Column alignment, truncation, the "showing N of M" line. |
| `infra/reset.sh` | The guarded `infra:reset` preflight. |
| `docs/adr/0002-discovery-datastore.md` | The decision record. |

**Modify:**

| File | Change |
|---|---|
| `apps/workers/src/discovery/index.ts` | `runDiscovery(options, deps)`; drop `createRuntime`, drop local `outcomes`. |
| `apps/workers/src/cli/program.ts` | Three new commands, three new `Handlers` members. |
| `apps/workers/src/cli/handlers.ts` | Wire `createDataStore()` into four handlers. |
| `apps/workers/src/lib/config.ts` | `DISCOVERY_STORE`. |
| `apps/workers/package.json` | Add `ulid`. |
| `packages/cache/src/keys.ts` | Delete `discoveryKeys`, `slugifyQuery`, `bucketChar`, `legacyDiscoveryStateKey`. |
| `packages/cache/src/keys.test.ts` | Delete the discovery-key tests. |
| `eslint.config.mjs` | Two tightenings. |
| `mise.toml` | Three tasks; `infra:reset` calls the script. |
| `AGENTS.md` | §3, §4, §4.1, §5, §7, §8, §14. |

**Delete:** `apps/workers/src/discovery/store.ts`, `apps/workers/src/discovery/store.test.ts` (contents move to `store/`).

---

## Phase 1 — The port

### Task 1: `DataStore` types and shared predicates

**Files:**
- Create: `apps/workers/src/lib/data-store.ts`
- Test: `apps/workers/src/lib/data-store.test.ts`

The interface itself has no runtime behaviour, but the three predicates every implementation
shares do. Those are what this task tests.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/lib/data-store.test.ts
import { describe, expect, it } from 'vitest';
import { assertDocumentId, compareBySort, matchesWhere, projectFields } from './data-store';

describe('matchesWhere', () => {
  it('is true when every field matches', () => {
    expect(matchesWhere({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
  });

  it('is false when any field differs', () => {
    expect(matchesWhere({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toBe(false);
  });

  it('is false when a field is absent, rather than matching undefined', () => {
    expect(matchesWhere({ a: 1 }, { missing: 'x' })).toBe(false);
  });

  it('is true for an absent or empty predicate', () => {
    expect(matchesWhere({ a: 1 }, undefined)).toBe(true);
    expect(matchesWhere({ a: 1 }, {})).toBe(true);
  });

  it('compares strictly, so 1 does not match "1"', () => {
    expect(matchesWhere({ a: 1 }, { a: '1' as unknown as number })).toBe(false);
  });
});

describe('projectFields', () => {
  it('keeps only the named fields', () => {
    expect(projectFields({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('omits a named field the document does not have, rather than adding undefined', () => {
    expect(projectFields({ a: 1 }, ['a', 'nope'])).toEqual({ a: 1 });
  });

  it('returns the whole document when no fields are named', () => {
    expect(projectFields({ a: 1, b: 2 }, undefined)).toEqual({ a: 1, b: 2 });
  });
});

describe('assertDocumentId', () => {
  it('accepts letters, digits, hyphens and underscores', () => {
    expect(() => assertDocumentId('kubernetes_20038725', 'widgets', 'id')).not.toThrow();
    expect(() => assertDocumentId('a-b_C9', 'widgets', 'id')).not.toThrow();
  });

  it('rejects a separator that a backend would refuse, naming the collection and field', () => {
    // Meilisearch primary keys allow only [a-zA-Z0-9_-]; a colon is the obvious id separator
    // to reach for and it silently fails at write time, far from the code that chose it.
    expect(() => assertDocumentId('kubernetes:1', 'widgets', 'id')).toThrow(/widgets\.id/);
    expect(() => assertDocumentId('a/b', 'widgets', 'id')).toThrow();
    expect(() => assertDocumentId('a.b', 'widgets', 'id')).toThrow();
  });

  it('rejects an empty id and the string "undefined"', () => {
    expect(() => assertDocumentId('', 'widgets', 'id')).toThrow(/widgets\.id/);
    expect(() => assertDocumentId('undefined', 'widgets', 'id')).toThrow(/missing/);
  });

  it('rejects a genuinely undefined id, not just the string "undefined"', () => {
    // RegExp.test(undefined) coerces its argument to "undefined" and returns true, so the
    // charset check alone does not catch a missing primary key — which is the one thing this
    // function exists to catch.
    expect(() => assertDocumentId(undefined, 'widgets', 'id')).toThrow(/missing/);
    expect(() => assertDocumentId(42, 'widgets', 'id')).toThrow(/missing/);
  });

  it('rejects an id longer than a filename can be', () => {
    // The boundary is 250, not 255: the filesystem store appends `.json`, so a 255-character
    // id makes a 260-byte path segment and hits the ENAMETOOLONG this bound exists to prevent.
    // Asserting the length message specifically, not just the field name — both other error
    // paths mention `widgets.id` too, so a weaker pattern would not catch this check throwing
    // the wrong error.
    expect(() => assertDocumentId('a'.repeat(251), 'widgets', 'id')).toThrow(/251 characters/);
    expect(() => assertDocumentId('a'.repeat(250), 'widgets', 'id')).not.toThrow();
  });
});

describe('compareBySort', () => {
  const docs = () => [
    { id: 'b', rank: 2, name: 'beta' },
    { id: 'a', rank: 1, name: 'alpha' },
    { id: 'c', rank: 2, name: 'gamma' },
  ];

  it('sorts ascending', () => {
    const sorted = docs().sort(compareBySort([['rank', 'asc']]));
    expect(sorted.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts descending', () => {
    const sorted = docs().sort(compareBySort([['rank', 'desc']]));
    expect(sorted.map((d) => d.rank)).toEqual([2, 2, 1]);
  });

  it('falls through to the next key on a tie', () => {
    const sorted = docs().sort(compareBySort([['rank', 'desc'], ['name', 'asc']]));
    expect(sorted.map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders missing values last regardless of direction or input order', () => {
    // Input order matters here, and a longer array does not help: V8's insertion sort always
    // passes the LATER element as `left`, so a one-order test only ever reaches the
    // `right`-missing branch and a mutation of the other branch stays invisible.
    const present = { id: 'y', rank: 5 };
    const absent = { id: 'x' };
    const nulled = { id: 'z', rank: null };
    for (const dir of ['asc', 'desc'] as const) {
      const cmp = compareBySort([['rank', dir]]);
      expect([absent, present].sort(cmp).map((d) => d.id)).toEqual(['y', 'x']);
      expect([present, absent].sort(cmp).map((d) => d.id)).toEqual(['y', 'x']);
    }
    // null and absent are one equivalence class: they must compare equal BOTH ways, or the
    // comparator is not antisymmetric and the sorted order depends on input order.
    const cmp = compareBySort([['rank', 'asc']]);
    expect(cmp(absent, nulled)).toBe(0);
    expect(cmp(nulled, absent)).toBe(0);
  });

  it('compares strings by codepoint, not locale', () => {
    const rows = [{ id: 'B' }, { id: 'a' }];
    expect(rows.sort(compareBySort([['id', 'asc']])).map((d) => d.id)).toEqual(['B', 'a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/lib/data-store.test.ts`
Expected: FAIL — `Failed to resolve import "./data-store"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/lib/data-store.ts
/**
 * The persistence port for the write side's *non-cache* data (AGENTS.md §4).
 *
 * This file must never import a backend. Workers depend on this interface; exactly one file
 * in the repo — `apps/workers/src/cli/data-store.ts` — knows what implements it. The whole
 * point of the port is that a worker cannot tell whether it is talking to Meilisearch, the
 * filesystem or a Map.
 *
 * That is a convention today and a lint rule from Task 17 of the migration, which adds
 * `apps/workers/src/lib/**` to `eslint.config.mjs`'s `@keco/search` ban.
 *
 * Related but distinct: `Storage` in @keco/cache is the port for *cached* artifacts, which
 * are keyed blobs with no filtering. This one is for documents you need to filter, sort and
 * count. Both are write-model storage; neither is a read model (§2 of the spec).
 */

/** A stored document. JSON-serialisable, carrying its id under the collection's primary key. */
export type Document = Record<string, unknown>;

/**
 * Equality only, and deliberately so. A richer predicate language would either leak one
 * backend's filter syntax into every worker that touches the port, or require this file to
 * grow an expression compiler for each implementation. Discovery needs `query_slug = x`.
 */
export type Where = Record<string, string | number | boolean>;

/** Field + direction. Every field named here must be declared `sortable` on the spec. */
export type Sort = readonly (readonly [field: string, direction: 'asc' | 'desc'])[];

export type CollectionSpec = {
  name: string;
  primaryKey: string;
  /** Fields a `Where` may reference. */
  filterable?: readonly string[];
  /** Fields a `ListQuery.sort` may reference. */
  sortable?: readonly string[];
  /**
   * Fields exposed to full-text search by backends that have one. This is a *provisioning
   * declaration*, not a capability the port offers — see `DataStore`'s note on search.
   */
  searchable?: readonly string[];
};

export type PutOptions = {
  /**
   * Resolve only when this write **and every earlier write through this handle** is durable.
   *
   * The second half is the contract, and it is what replaces the filesystem store's
   * write-ordering guarantee. Discovery writes its corpus without it and its resume state
   * with it, so state can never become durable while claiming windows whose repos are still
   * in flight — which would silently truncate the corpus with nothing to signal it.
   */
  durable?: boolean;
};

export type ListQuery = {
  where?: Where;
  fields?: readonly string[];
  /**
   * Intended together with `limit`. A backend with no native sort has to buffer the whole
   * result set to order it, so an unbounded sorted listing over a 100k collection is a
   * memory cost, not just a slow one. Every caller in this repo passes both.
   */
  sort?: Sort;
  /** Stop after N documents. Lets an implementation avoid over-fetching a 100k collection. */
  limit?: number;
};

export interface DataStore {
  /** Idempotent. Called once at startup, before any other call. */
  ensure(specs: readonly CollectionSpec[]): Promise<void>;

  /**
   * Upsert. **Every implementation must deep-copy `documents` synchronously, before its
   * first `await`.** Discovery aliases live, mutating arrays into the documents it writes
   * (see `runDiscovery`'s work queue), so an implementation that serialises after an await
   * can persist a half-mutated array and lose windows. The conformance suite pins this.
   */
  put(collection: string, documents: readonly Document[], options?: PutOptions): Promise<void>;

  get(collection: string, id: string): Promise<Document | null>;

  /**
   * Cardinality without streaming. `list` cannot serve this: counting 100k documents to
   * produce one number is exactly what the explore commands must not do.
   */
  count(collection: string, where?: Where): Promise<number>;

  /**
   * Pages internally; the caller never sees an offset.
   *
   * Mutating the collection *during* an iteration is undefined: the three implementations
   * genuinely differ (one snapshots up front, one snapshots keys and reads through, one
   * pages by offset and can skip or repeat a row as offsets shift). Read fully, then write —
   * which is what discovery's resume path does.
   */
  list(collection: string, query?: ListQuery): AsyncIterable<Document>;

  /**
   * Deletes every document matching `where`.
   *
   * An empty `where` is refused, not treated as "match everything" — see
   * `assertNonEmptyWhere`. Callers that genuinely want to empty a collection say so by
   * naming the field they are matching on.
   */
  remove(collection: string, where: Where): Promise<void>;
}

/**
 * There is no `search()`, on purpose. `CollectionSpec.searchable` tells an implementation
 * that has full-text to build an index over those fields, so a human or the backoffice can
 * query it directly — but no worker can express a relevance query. Adding `search()` here
 * would put a search engine's semantics back into every worker, which is the one change this
 * port exists to prevent.
 */

// ── shared predicates ────────────────────────────────────────────────────────
// Implemented once here rather than three times, because a `where` that means something
// slightly different in the fs store than in the memory store is a bug no test would catch
// unless every implementation ran the same suite — which is exactly why they do.

/**
 * `matchesWhere` answers true for an empty predicate, which is right for `list` and `count` —
 * "no filter" means "everything". For `remove` the same rule would make one missing argument
 * silently delete a whole collection, so `remove` refuses it instead.
 *
 * Enforced here rather than per implementation because the three would otherwise disagree in
 * the worst possible direction: two backends wiping the corpus where the third errors.
 */
export function assertNonEmptyWhere(where: Where, collection: string): void {
  if (Object.keys(where).length === 0) {
    throw new Error(
      `refusing to remove from "${collection}" with an empty filter — name the field to ` +
        'match on, or delete the collection deliberately',
    );
  }
}

export function matchesWhere(document: Document, where: Where | undefined): boolean {
  if (where === undefined) return true;
  for (const [field, value] of Object.entries(where)) {
    if (document[field] !== value) return false;
  }
  return true;
}

export function projectFields(
  document: Document,
  fields: readonly string[] | undefined,
): Document {
  if (fields === undefined) return document;
  const out: Document = {};
  for (const field of fields) {
    // The guard is what keeps a named-but-absent field out of the result rather than adding
    // it as `undefined`. `in` rather than `!== undefined` so a field the document genuinely
    // carries counts as present whatever it holds; only absence drops it.
    if (field in document) out[field] = document[field];
  }
  return out;
}

/**
 * Codepoint comparison, never `localeCompare` — ICU collation differs between machines, and
 * the same data sorting differently on two hosts turns every listing into a spurious diff.
 * Missing values sort last in both directions: "no value" is not smaller than every value,
 * it is absent, and burying it is what an operator reading a table expects.
 */
export function compareBySort(sort: Sort): (a: Document, b: Document) => number {
  return (a, b) => {
    for (const [field, direction] of sort) {
      const left = a[field];
      const right = b[field];
      // Missing is ONE equivalence class. `null` and absent must compare equal, or the
      // comparator stops being antisymmetric (`cmp(null, absent)` and `cmp(absent, null)`
      // would both answer 1) and the sorted order starts depending on input order — the very
      // non-determinism this function exists to prevent. It is reachable: `duration_ms` is
      // sortable on `discovery_runs`, and a run still `running` has no duration, which one
      // backend stores as null and another omits.
      //
      // Known and deliberately unfixed: a field holding two different types (`5` vs `'abc'`)
      // has the same hole, because both `<` comparisons are false. `NaN` would too, and is
      // additionally non-reflexive, but no implementation can return one: `Document` is
      // JSON-serialisable, JSON has no NaN, and all three stores normalise through JSON on
      // write, so a stored NaN reads back as null and lands in the missing class above.
      // A sortable field with mixed types is a data bug in the caller, and fixing it needs a
      // type-ordering rule the port has no business inventing.
      const leftMissing = left === undefined || left === null;
      const rightMissing = right === undefined || right === null;
      if (leftMissing && rightMissing) continue;
      if (leftMissing) return 1;
      if (rightMissing) return -1;
      if (left === right) continue;
      const order = left < right ? -1 : 1;
      return direction === 'desc' ? -order : order;
    }
    return 0;
  };
}

/**
 * The portable document-id charset: the intersection of what every plausible backend accepts
 * as a primary key. Meilisearch is the strict one — `[a-zA-Z0-9_-]` only — and the
 * filesystem store additionally needs an id that is a safe filename, which this also gives.
 *
 * Validated in the port rather than per implementation so an id that works in tests cannot
 * fail in production. The obvious id separator to reach for is a colon (`kubernetes:20038725`)
 * and Meilisearch rejects it at write time, a long way from the code that chose the format.
 */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Without a bound, a long `--query` produces an id the memory and Meilisearch stores accept
 * and the filesystem store rejects with ENAMETOOLONG — a per-implementation divergence that
 * surfaces as a mysterious conformance failure rather than as the input-validation error it
 * actually is.
 *
 * 250 rather than 255, and the five bytes are not slack: `NAME_MAX` is 255, and the
 * filesystem store appends `.json` to the id to form the final path segment
 * (`data/{collection}/{id}.json`), so the id itself gets 250. The charset is ASCII-only, so
 * characters equal bytes and the arithmetic is exact. Raise this to 255 and a maximum-length
 * id produces a 260-byte filename — the exact failure the bound exists to prevent.
 */
export const MAX_DOCUMENT_ID_LENGTH = 250;

/**
 * Takes `unknown`, not `string`, and that is load-bearing. `document[primaryKey]` is typed
 * `unknown`, so a `string` signature invites `assertDocumentId(doc[pk] as string, …)` at every
 * call site — and the cast defeats the guard entirely: `/^[A-Za-z0-9_-]+$/.test(undefined)`
 * coerces its argument to the string `"undefined"` and returns **true**, so a genuinely
 * missing primary key would sail through the exact check meant to catch it.
 */
export function assertDocumentId(
  id: unknown,
  collection: string,
  primaryKey: string,
): asserts id is string {
  if (typeof id !== 'string' || id === '' || id === 'undefined' || id === 'null') {
    throw new Error(`document for ${collection}.${primaryKey} is missing its primary key`);
  }
  if (id.length > MAX_DOCUMENT_ID_LENGTH) {
    throw new Error(
      `document id for ${collection}.${primaryKey} is ${id.length} characters — ` +
        `the limit is ${MAX_DOCUMENT_ID_LENGTH}`,
    );
  }
  if (!DOCUMENT_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid document id ${JSON.stringify(id)} for ${collection}.${primaryKey} — ` +
        'ids may contain only letters, digits, hyphens and underscores',
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/lib/data-store.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/lib/data-store.ts apps/workers/src/lib/data-store.test.ts
git commit -m "feat(workers): add the DataStore port

The persistence port for write-side data that needs filtering, sorting
and counting — as opposed to @keco/cache's Storage, which is keyed
blobs. No backend imports, now or ever.

The where/sort/fields predicates live here rather than in each
implementation: three subtly different definitions of equality is a bug
no per-implementation test would find. assertDocumentId is here for the
same reason: an id that works in the memory store but that Meilisearch
rejects is a failure that only shows up in production."
```

---

### Task 2: The conformance suite

**Files:**
- Create: `apps/workers/src/lib/data-store.conformance.ts`

One suite, run by every implementation. This is the task that makes "three backends behave
identically" a checked fact rather than an intention. It is written before any implementation
exists, so it defines the contract rather than describing whatever the first one happened to do.

Note this file is `.conformance.ts`, not `.test.ts`: vitest's `include` globs only pick up
`*.test.ts`, so this is never collected on its own — it is imported by the three test files
that pass it a factory.

- [ ] **Step 1: Write the suite**

```ts
// apps/workers/src/lib/data-store.conformance.ts
import { describe, expect, it } from 'vitest';
import type { CollectionSpec, DataStore } from './data-store';

/**
 * The contract every DataStore implementation must satisfy, exercised identically against
 * all three. An implementation that passes its own hand-written tests but not this suite is
 * a backend that behaves differently from the others, which is the failure mode the port
 * exists to prevent.
 */

/**
 * The collections the suite exercises. A `prefix` because the Meilisearch implementation runs
 * this against a shared, real server, where fixed names would collide with anything else
 * using them. The other two implementations start empty every time and pass no prefix.
 */
export function conformanceSpecs(prefix = ''): readonly CollectionSpec[] {
  return [
    {
      name: `${prefix}widgets`,
      primaryKey: 'id',
      filterable: ['group', 'active'],
      sortable: ['rank', 'name'],
      searchable: ['name'],
    },
    // A DIFFERENT primary key on purpose. With `id` on both collections, an implementation
    // that hardcodes 'id' passes the whole suite — and then breaks on `discovery_runs`
    // (`run_id`) and `discovery_state` (`query_slug`), far from here.
    { name: `${prefix}notes`, primaryKey: 'note_id', filterable: ['group'] },
  ];
}

export type Harness = {
  store: DataStore;
  /** Tear down whatever the factory created — a temp dir, nothing. */
  close?: () => Promise<void>;
};

const widget = (id: string, group: string, rank: number, name = id) => ({
  id,
  group,
  rank,
  name,
  active: true,
});

const collect = async (iterable: AsyncIterable<Record<string, unknown>>) => {
  const out: Record<string, unknown>[] = [];
  for await (const item of iterable) out.push(item);
  return out;
};

export function describeDataStore(
  name: string,
  open: () => Promise<Harness>,
  prefix = '',
): void {
  const specs = conformanceSpecs(prefix);
  const WIDGETS = specs[0]!.name;
  const NOTES = specs[1]!.name;

  describe(`DataStore conformance: ${name}`, () => {
    /** Each test gets its own store: shared state between tests hides ordering bugs. */
    const withStore = async (body: (store: DataStore) => Promise<void>) => {
      const harness = await open();
      await harness.store.ensure(specs);
      try {
        await body(harness.store);
      } finally {
        await harness.close?.();
      }
    };

    it('round-trips a document', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)], { durable: true });
        expect(await store.get(WIDGETS, 'a')).toMatchObject({ id: 'a', group: 'x', rank: 1 });
      });
    });

    it('returns null for a document that is not there', async () => {
      await withStore(async (store) => {
        expect(await store.get(WIDGETS, 'nope')).toBeNull();
      });
    });

    it('upserts rather than duplicating on the same primary key', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)]);
        await store.put(WIDGETS, [widget('a', 'y', 2)], { durable: true });
        expect(await store.get(WIDGETS, 'a')).toMatchObject({ group: 'y', rank: 2 });
        expect(await store.count(WIDGETS)).toBe(1);
      });
    });

    it('keeps collections separate', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)]);
        await store.put(NOTES, [{ note_id: 'a', group: 'x', body: 'hello' }], { durable: true });
        expect(await store.get(NOTES, 'a')).toMatchObject({ body: 'hello' });
        expect(await store.get(WIDGETS, 'a')).not.toHaveProperty('body');
      });
    });

    it('ensure() is idempotent', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)], { durable: true });
        await store.ensure(specs);
        expect(await store.get(WIDGETS, 'a')).not.toBeNull();
      });
    });

    it('counts with and without a filter', async () => {
      await withStore(async (store) => {
        await store.put(
          WIDGETS,
          [widget('a', 'x', 1), widget('b', 'x', 2), widget('c', 'y', 3)],
          { durable: true },
        );
        expect(await store.count(WIDGETS)).toBe(3);
        expect(await store.count(WIDGETS, { group: 'x' })).toBe(2);
        expect(await store.count(WIDGETS, { group: 'nothing' })).toBe(0);
      });
    });

    it('counts a collection larger than one page', async () => {
      // The failure this catches is an implementation counting one page and reporting it as
      // the total — invisible on the three-document collections above.
      await withStore(async (store) => {
        const many = Array.from({ length: 250 }, (_, i) =>
          widget(`w${String(i).padStart(3, '0')}`, i % 2 === 0 ? 'even' : 'odd', i),
        );
        await store.put(WIDGETS, many, { durable: true });
        expect(await store.count(WIDGETS)).toBe(250);
        expect(await store.count(WIDGETS, { group: 'even' })).toBe(125);
      });
    });

    it('lists every document, and lists a filtered subset', async () => {
      await withStore(async (store) => {
        await store.put(
          WIDGETS,
          [widget('a', 'x', 1), widget('b', 'x', 2), widget('c', 'y', 3)],
          { durable: true },
        );
        expect(await collect(store.list(WIDGETS))).toHaveLength(3);
        const filtered = await collect(store.list(WIDGETS, { where: { group: 'x' } }));
        expect(filtered.map((d) => d.id).sort()).toEqual(['a', 'b']);
      });
    });

    it('lists across page boundaries without dropping or duplicating', async () => {
      await withStore(async (store) => {
        const many = Array.from({ length: 250 }, (_, i) =>
          widget(`w${String(i).padStart(3, '0')}`, 'x', i),
        );
        await store.put(WIDGETS, many, { durable: true });
        const ids = (await collect(store.list(WIDGETS))).map((d) => d.id);
        expect(ids).toHaveLength(250);
        expect(new Set(ids).size).toBe(250);
      });
    });

    it('projects only the named fields', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)], { durable: true });
        const [row] = await collect(store.list(WIDGETS, { fields: ['id', 'rank'] }));
        expect(Object.keys(row!).sort()).toEqual(['id', 'rank']);
      });
    });

    it('sorts, in both directions, and applies limit after sorting', async () => {
      await withStore(async (store) => {
        await store.put(
          WIDGETS,
          [widget('a', 'x', 1), widget('b', 'x', 3), widget('c', 'x', 2)],
          { durable: true },
        );
        const desc = await collect(store.list(WIDGETS, { sort: [['rank', 'desc']] }));
        expect(desc.map((d) => d.rank)).toEqual([3, 2, 1]);

        // The bug this catches: limiting first, then sorting the truncated slice — which
        // returns the smallest of an arbitrary subset instead of the largest overall.
        const top = await collect(store.list(WIDGETS, { sort: [['rank', 'desc']], limit: 2 }));
        expect(top.map((d) => d.rank)).toEqual([3, 2]);
      });
    });

    it('limits without a sort', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1), widget('b', 'x', 2)], { durable: true });
        expect(await collect(store.list(WIDGETS, { limit: 1 }))).toHaveLength(1);
      });
    });

    it('lists nothing for an empty collection rather than throwing', async () => {
      await withStore(async (store) => {
        expect(await collect(store.list(WIDGETS))).toEqual([]);
      });
    });

    it('removes only what the filter matches', async () => {
      await withStore(async (store) => {
        await store.put(
          WIDGETS,
          [widget('a', 'x', 1), widget('b', 'x', 2), widget('c', 'y', 3)],
          { durable: true },
        );
        await store.remove(WIDGETS, { group: 'x' });
        expect(await store.count(WIDGETS)).toBe(1);
        expect(await store.get(WIDGETS, 'c')).not.toBeNull();
      });
    });

    it('removing a filter that matches nothing is not an error', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)], { durable: true });
        await store.remove(WIDGETS, { group: 'gone' });
        expect(await store.count(WIDGETS)).toBe(1);
      });
    });

    it('deep-copies on put, so a caller mutating its array afterwards changes nothing', async () => {
      // This is the queue-aliasing hazard, pinned. runDiscovery aliases state.pending_windows
      // as its live work queue and keeps mutating it while a flush is in flight; an
      // implementation that serialises after an await persists a half-mutated array and
      // silently loses windows. Every implementation must copy synchronously, before its
      // first await.
      await withStore(async (store) => {
        const windows = ['w1', 'w2'];
        const document = { id: 'a', group: 'x', rank: 1, windows };

        const inFlight = store.put(WIDGETS, [document], { durable: true });
        windows.push('MUTATED-DURING-PUT');
        document.rank = 999;
        await inFlight;

        expect(await store.get(WIDGETS, 'a')).toMatchObject({ rank: 1, windows: ['w1', 'w2'] });
      });
    });

    it('honours each collection\'s own primary key', async () => {
      await withStore(async (store) => {
        await store.put(NOTES, [{ note_id: 'n1', group: 'x' }], { durable: true });
        expect(await store.get(NOTES, 'n1')).toMatchObject({ note_id: 'n1' });
      });
    });

    it('accepts an empty put as a no-op rather than erroring', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [], { durable: true });
        expect(await store.count(WIDGETS)).toBe(0);
      });
    });

    it('refuses remove with an empty filter instead of emptying the collection', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)], { durable: true });
        await expect(store.remove(WIDGETS, {})).rejects.toThrow(/empty filter/);
        expect(await store.count(WIDGETS)).toBe(1);
      });
    });

    it('rejects a document with no value for its primary key', async () => {
      await withStore(async (store) => {
        await expect(
          store.put(WIDGETS, [{ group: 'x', rank: 1 }], { durable: true }),
        ).rejects.toThrow(/primary key/);
      });
    });

    it('copies on the way out, so a caller cannot edit the store by mutating what it read', async () => {
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1)], { durable: true });

        const first = (await store.get(WIDGETS, 'a')) as Record<string, unknown>;
        first.rank = 999;
        expect(await store.get(WIDGETS, 'a')).toMatchObject({ rank: 1 });

        const [listed] = await collect(store.list(WIDGETS));
        (listed as Record<string, unknown>).rank = 998;
        expect(await store.get(WIDGETS, 'a')).toMatchObject({ rank: 1 });
      });
    });

    it('refuses every operation on a collection that was never ensured', async () => {
      await withStore(async (store) => {
        await expect(store.get('never_ensured', 'a')).rejects.toThrow();
        await expect(store.count('never_ensured')).rejects.toThrow();
        await expect(collect(store.list('never_ensured'))).rejects.toThrow();
        await expect(store.put('never_ensured', [{ id: 'a' }])).rejects.toThrow();
        await expect(store.remove('never_ensured', { group: 'x' })).rejects.toThrow();
      });
    });

    it('writes nothing when any document in a batch is invalid', async () => {
      await withStore(async (store) => {
        await expect(
          store.put(
            WIDGETS,
            [widget('a', 'x', 1), widget('b', 'x', 2), { group: 'x', rank: 3 }],
            { durable: true },
          ),
        ).rejects.toThrow(/primary key/);
        expect(await store.count(WIDGETS)).toBe(0);
      });
    });

    it('normalises stored documents through JSON, as every real backend does', async () => {
      await withStore(async (store) => {
        await store.put(
          WIDGETS,
          [
            {
              id: 'a',
              group: 'x',
              rank: 1,
              when: new Date('2026-01-02T03:04:05.000Z'),
              nan: Number.NaN,
              absent: undefined,
            },
          ],
          { durable: true },
        );

        const stored = (await store.get(WIDGETS, 'a')) as Record<string, unknown>;
        expect(stored.when).toBe('2026-01-02T03:04:05.000Z');
        expect(stored.nan).toBeNull();
        expect('absent' in stored).toBe(false);
      });
    });

    it('a durable put implies every earlier put is durable too', async () => {
      // The ordering half of PutOptions.durable. Discovery writes its corpus without waiting
      // and its resume state with it; if state can land first, a crash leaves state claiming
      // windows whose repos were never written.
      await withStore(async (store) => {
        await store.put(WIDGETS, [widget('a', 'x', 1), widget('b', 'x', 2)]);
        await store.put(NOTES, [{ note_id: 'state', group: 'x', done: ['a', 'b'] }], {
          durable: true,
        });

        expect(await store.count(WIDGETS)).toBe(2);
      });
    });
  });
}
```

- [ ] **Step 2: Verify it compiles and collects nothing on its own**

Run: `pnpm -F @keco/workers check`
Expected: passes.

Then confirm the file contributes no tests of its own — it is not a `*.test.ts`, so vitest's
`include` glob must not collect it:

Run: `pnpm vitest run apps/workers/src/lib/ --reporter=verbose | grep -c "DataStore conformance"`
Expected: `0`.

(`apps/workers/src/lib/` already holds `cli.test.ts`, `progress.test.ts` and
`shutdown.test.ts`, so the directory's total test count is not a useful signal here. The
absence of the suite's own describe block is.)

- [ ] **Step 3: Commit**

```bash
git add apps/workers/src/lib/data-store.conformance.ts
git commit -m "test(workers): add the DataStore conformance suite

One suite, run by all three implementations, written before any of them
exist so it defines the contract rather than describing the first one.

Two tests earn their keep beyond the obvious CRUD: the deep-copy-on-put
test pins the queue-aliasing hazard (runDiscovery mutates the array it
is writing), and the durable-ordering test pins the guarantee that lets
the corpus be written without waiting."
```

---

### Task 3: `InMemoryDataStore`

**Files:**
- Create: `apps/workers/src/lib/data-store.memory.ts`
- Test: `apps/workers/src/lib/data-store.memory.test.ts`

The test double. Once this passes, every later task in Phases 2–4 can be tested with no
Meilisearch, no Docker and no filesystem.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/lib/data-store.memory.test.ts
import { describeDataStore } from './data-store.conformance';
import { InMemoryDataStore } from './data-store.memory';

describeDataStore('InMemoryDataStore', async () => ({ store: new InMemoryDataStore() }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/lib/data-store.memory.test.ts`
Expected: FAIL — `Failed to resolve import "./data-store.memory"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/lib/data-store.memory.ts
import {
  assertDocumentId,
  assertNonEmptyWhere,
  compareBySort,
  matchesWhere,
  projectFields,
  type CollectionSpec,
  type DataStore,
  type Document,
  type ListQuery,
  type Where,
} from './data-store';

/**
 * The in-memory DataStore. Its job is to make every test in Phases 2–4 run with no backend:
 * discovery's store, its resume path and all three explore commands are exercised against
 * this, and only the Meilisearch-specific mapping needs a server.
 *
 * It is also the reference semantics. Where the conformance suite is ambiguous, this is what
 * the other two are matched against.
 */
/**
 * The normalisation every real backend applies on the way to storage. Kept here rather than in
 * the port because it is not a rule the port imposes — it is a fact about how JSON-backed
 * stores behave, which this double exists to reproduce.
 */
const jsonClone = (document: Document): Document =>
  JSON.parse(JSON.stringify(document)) as Document;

export class InMemoryDataStore implements DataStore {
  private readonly specs = new Map<string, CollectionSpec>();
  private readonly collections = new Map<string, Map<string, Document>>();

  async ensure(specs: readonly CollectionSpec[]): Promise<void> {
    for (const spec of specs) {
      this.specs.set(spec.name, spec);
      if (!this.collections.has(spec.name)) this.collections.set(spec.name, new Map());
    }
  }

  async put(collection: string, documents: readonly Document[]): Promise<void> {
    // Synchronous copy before any await — the port's deep-copy contract.
    //
    // A JSON round-trip rather than structuredClone, deliberately. structuredClone is the
    // better clone and the wrong one here: it preserves Date, NaN and undefined-valued keys,
    // while the filesystem store (JSON.stringify) and Meilisearch (JSON over HTTP) turn those
    // into an ISO string, null, and a dropped key. This is the reference double, so being
    // *more* faithful than production is the dangerous direction.
    //
    // Validation happens in this pass, before anything is written, so a batch with one bad
    // document lands nothing. The filesystem and Meilisearch stores get that for free by
    // building their whole payload before issuing a write; doing it by accident here would
    // leave the reference double with partial-write behaviour neither real backend has.
    //
    // The id is passed raw, not String()-ed: assertDocumentId takes `unknown` precisely so a
    // missing primary key reaches its typeof check instead of arriving as "undefined".
    const primaryKey = this.primaryKeyOf(collection);
    const copies = documents.map((document) => {
      const copy = jsonClone(document);
      const id = copy[primaryKey];
      assertDocumentId(id, collection, primaryKey);
      return [id, copy] as const;
    });

    const target = this.collectionOf(collection);
    for (const [id, copy] of copies) target.set(id, copy);
  }

  async get(collection: string, id: string): Promise<Document | null> {
    const found = this.collectionOf(collection).get(id);
    // Copy on read too, or a caller mutating what it read silently edits the store.
    return found === undefined ? null : jsonClone(found);
  }

  async count(collection: string, where?: Where): Promise<number> {
    let total = 0;
    for (const document of this.collectionOf(collection).values()) {
      if (matchesWhere(document, where)) total += 1;
    }
    return total;
  }

  async *list(collection: string, query: ListQuery = {}): AsyncIterable<Document> {
    let rows = [...this.collectionOf(collection).values()].filter((document) =>
      matchesWhere(document, query.where),
    );
    // Sort before limit, never after: limiting first returns the top of an arbitrary subset.
    if (query.sort !== undefined) rows = rows.sort(compareBySort(query.sort));
    if (query.limit !== undefined) rows = rows.slice(0, query.limit);
    for (const row of rows) {
      yield projectFields(jsonClone(row), query.fields);
    }
  }

  async remove(collection: string, where: Where): Promise<void> {
    assertNonEmptyWhere(where, collection);
    const target = this.collectionOf(collection);
    for (const [id, document] of [...target.entries()]) {
      if (matchesWhere(document, where)) target.delete(id);
    }
  }

  private collectionOf(collection: string): Map<string, Document> {
    const found = this.collections.get(collection);
    if (found === undefined) {
      throw new Error(`unknown collection "${collection}" — call ensure() first`);
    }
    return found;
  }

  private primaryKeyOf(collection: string): string {
    const spec = this.specs.get(collection);
    if (spec === undefined) {
      throw new Error(`unknown collection "${collection}" — call ensure() first`);
    }
    return spec.primaryKey;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/lib/data-store.memory.test.ts`
Expected: PASS, 25 tests (the full conformance suite).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/lib/data-store.memory.ts apps/workers/src/lib/data-store.memory.test.ts
git commit -m "feat(workers): add InMemoryDataStore

Passes the full conformance suite. This is what lets every later test
in the migration run with no Meilisearch, no Docker and no filesystem —
and it is the reference semantics the other two are matched against."
```

---

### Task 4: `FsDataStore`

**Files:**
- Create: `apps/workers/src/lib/data-store.fs.ts`
- Test: `apps/workers/src/lib/data-store.fs.test.ts`

Preserves offline sweeps and hand-inspectable data under `DISCOVERY_STORE=fs`. It goes
through the existing `Storage` port rather than `node:fs`, per AGENTS.md §14.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/lib/data-store.fs.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@keco/cache';
import { describe, expect, it } from 'vitest';
import { describeDataStore } from './data-store.conformance';
import { FsDataStore, documentKey } from './data-store.fs';

describeDataStore('FsDataStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keco-datastore-'));
  return {
    store: new FsDataStore(new FsStorage(dir)),
    close: () => rm(dir, { recursive: true, force: true }),
  };
});

describe('documentKey', () => {
  it('namespaces by collection so two collections can share an id', () => {
    expect(documentKey('widgets', 'a')).toBe('data/widgets/a.json');
    expect(documentKey('notes', 'a')).toBe('data/notes/a.json');
  });
});

describe('FsDataStore data layout', () => {
  it('writes one readable JSON file per document, so a human can inspect it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'keco-datastore-'));
    try {
      const storage = new FsStorage(dir);
      const store = new FsDataStore(storage);
      await store.ensure([{ name: 'widgets', primaryKey: 'id' }]);
      await store.put('widgets', [{ id: 'a', rank: 1 }], { durable: true });

      const raw = await storage.get('data/widgets/a.json');
      expect(JSON.parse(raw!.toString('utf8'))).toEqual({ id: 'a', rank: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/lib/data-store.fs.test.ts`
Expected: FAIL — `Failed to resolve import "./data-store.fs"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/lib/data-store.fs.ts
import type { Storage } from '@keco/cache';
import {
  assertDocumentId,
  assertNonEmptyWhere,
  compareBySort,
  matchesWhere,
  projectFields,
  type CollectionSpec,
  type DataStore,
  type Document,
  type ListQuery,
  type PutOptions,
  type Where,
} from './data-store';

/**
 * The filesystem DataStore, for `DISCOVERY_STORE=fs`: offline sweeps, and a corpus you can
 * read with `cat`. Everything goes through the `Storage` port — no `node:fs`, no `path.join`
 * (AGENTS.md §14), so it inherits `FsStorage`'s atomic write-then-rename put.
 *
 * `count`, `list` and `remove` list a prefix and then read every document to apply the
 * filter. That is genuinely slow at 100k repos and it is the reason this is not the default:
 * AGENTS.md §14's "never LIST to find work" is about the *cache*, whose access pattern is
 * keys-only by design, and this store is the deliberate other thing — a small, local,
 * inspectable substrate for development. `ensure` provisions nothing because there is
 * nothing to provision: `filterable`, `sortable` and `searchable` are all satisfied by
 * reading everything.
 */

/** One file per document, namespaced by collection. `id` is validated by the port. */
export const documentKey = (collection: string, id: string): string =>
  `data/${collection}/${id}.json`;

const collectionPrefix = (collection: string): string => `data/${collection}/`;

export class FsDataStore implements DataStore {
  private readonly specs = new Map<string, CollectionSpec>();

  constructor(private readonly storage: Storage) {}

  async ensure(specs: readonly CollectionSpec[]): Promise<void> {
    for (const spec of specs) this.specs.set(spec.name, spec);
  }

  async put(
    collection: string,
    documents: readonly Document[],
    // Unused, but it must exist with the interface's own type: a caller holding a concrete
    // `FsDataStore` rather than the interface — the layout test below does — would otherwise
    // not typecheck. It is a no-op because `FsStorage.put` only resolves once its rename has
    // landed, so a sequentially-awaited put is already durable.
    _options?: PutOptions,
  ): Promise<void> {
    // JSON.stringify is synchronous, so serialising here — before any await — *is* the
    // port's deep-copy contract: what lands on disk is the state at call time, whatever the
    // caller does to its arrays afterwards.
    const primaryKey = this.primaryKeyOf(collection);
    const writes = documents.map((document) => {
      const id = document[primaryKey];
      assertDocumentId(id, collection, primaryKey);
      return { key: documentKey(collection, id), body: JSON.stringify(document) };
    });
    for (const write of writes) {
      await this.storage.put(write.key, write.body, 'application/json');
    }
  }

  async get(collection: string, id: string): Promise<Document | null> {
    // Validate the collection first, even though the key would resolve without it: an unknown
    // collection must throw here exactly as it does in the other two implementations, or a
    // typo silently reads as "no such document".
    this.primaryKeyOf(collection);
    const buffer = await this.storage.get(documentKey(collection, id));
    if (buffer === null) return null;
    return JSON.parse(buffer.toString('utf8')) as Document;
  }

  async count(collection: string, where?: Where): Promise<number> {
    let total = 0;
    for await (const document of this.readAll(collection)) {
      if (matchesWhere(document, where)) total += 1;
    }
    return total;
  }

  async *list(collection: string, query: ListQuery = {}): AsyncIterable<Document> {
    // Unsorted listing streams: the resume path reads the whole corpus and must not hold it
    // all in memory twice. A sorted listing has to buffer — you cannot sort a stream — which
    // is why `sort` is documented as intended with `limit`.
    if (query.sort === undefined) {
      let yielded = 0;
      for await (const document of this.readAll(collection)) {
        if (!matchesWhere(document, query.where)) continue;
        yield projectFields(document, query.fields);
        yielded += 1;
        if (query.limit !== undefined && yielded >= query.limit) return;
      }
      return;
    }

    const rows: Document[] = [];
    for await (const document of this.readAll(collection)) {
      if (matchesWhere(document, query.where)) rows.push(document);
    }
    rows.sort(compareBySort(query.sort));
    const limited = query.limit === undefined ? rows : rows.slice(0, query.limit);
    for (const row of limited) yield projectFields(row, query.fields);
  }

  async remove(collection: string, where: Where): Promise<void> {
    assertNonEmptyWhere(where, collection);
    const primaryKey = this.primaryKeyOf(collection);
    const doomed: string[] = [];
    for await (const document of this.readAll(collection)) {
      if (matchesWhere(document, where)) doomed.push(String(document[primaryKey]));
    }
    for (const id of doomed) await this.storage.delete(documentKey(collection, id));
  }

  /**
   * A document that fails to parse is skipped with the key named, not thrown: AGENTS.md §13
   * — one bad record must never abort a run, and this store's whole audience is a developer
   * who may well have hand-edited a file.
   */
  private async *readAll(collection: string): AsyncIterable<Document> {
    this.primaryKeyOf(collection); // fail fast on an unknown collection
    for (const key of await this.storage.list(collectionPrefix(collection))) {
      const buffer = await this.storage.get(key);
      if (buffer === null) continue;
      try {
        yield JSON.parse(buffer.toString('utf8')) as Document;
      } catch {
        continue;
      }
    }
  }

  private primaryKeyOf(collection: string): string {
    const spec = this.specs.get(collection);
    if (spec === undefined) {
      throw new Error(`unknown collection "${collection}" — call ensure() first`);
    }
    return spec.primaryKey;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/lib/data-store.fs.test.ts`
Expected: PASS, 29 tests (25 conformance + 4 layout).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/lib/data-store.fs.ts apps/workers/src/lib/data-store.fs.test.ts
git commit -m "feat(workers): add FsDataStore over the Storage port

Passes the same conformance suite as the in-memory store. Keeps offline
sweeps possible and the corpus readable with cat, under
DISCOVERY_STORE=fs.

Goes through Storage rather than node:fs (AGENTS.md §14), so it
inherits atomic write-then-rename. JSON.stringify before the first
await is what satisfies the port's deep-copy contract."
```

---

### Task 5: `MeilisearchDataStore`

**Files:**
- Create: `apps/workers/src/cli/data-store.ts`
- Test: `apps/workers/src/cli/data-store.test.ts`
- Test: `apps/workers/src/cli/data-store.integration.test.ts`

The production implementation, and **the only file in `apps/workers` outside the projector and
`handlers.ts` that may import `@keco/search`**. It lives in `cli/` because that is the
composition root — the place `eslint.config.mjs` already documents as holding the admin client.

Two notes on the API, both verified against `meilisearch@0.60.0`:

1. `getDocuments()` accepts `filter`, `fields`, `sort`, `limit` and `offset`, and returns
   `{ results, total }`. So `list` and `count` are both `getDocuments` — no `search()` call,
   and therefore no exposure to `pagination.maxTotalHits`.
2. `client.tasks.waitForTasks(uids)` waits on a *set* of tasks. This is better than the
   mechanism the spec sketched (§7 proposed awaiting the last task and then verifying the
   earlier ones in one `getTasks` call, which quietly assumes Meilisearch processes tasks
   FIFO). Waiting on the whole set assumes nothing about ordering and costs one call. **This
   is a deliberate strengthening of the spec; update spec §7 in Task 20.**

- [ ] **Step 1: Write the failing unit test**

These are the parts that need no server. The integration test in Step 5 covers the rest.

```ts
// apps/workers/src/cli/data-store.test.ts
import { describe, expect, it } from 'vitest';
import { settingsFor, settingsMatch, toFilter } from './data-store';

describe('toFilter', () => {
  it('is undefined for no predicate, so getDocuments returns everything', () => {
    expect(toFilter(undefined)).toBeUndefined();
    expect(toFilter({})).toBeUndefined();
  });

  it('quotes strings and joins with AND', () => {
    expect(toFilter({ query_slug: 'kubernetes', archived: false })).toBe(
      'query_slug = "kubernetes" AND archived = false',
    );
  });

  it('leaves numbers and booleans unquoted', () => {
    expect(toFilter({ stars: 100 })).toBe('stars = 100');
    expect(toFilter({ fork: true })).toBe('fork = true');
  });

  it('escapes quotes and backslashes so a value cannot break out of the filter', () => {
    expect(toFilter({ name: 'a"b' })).toBe('name = "a\\"b"');
    expect(toFilter({ name: 'a\\b' })).toBe('name = "a\\\\b"');
  });
});

describe('settingsFor', () => {
  it('maps a spec onto the three attribute lists', () => {
    expect(
      settingsFor({
        name: 'widgets',
        primaryKey: 'id',
        filterable: ['group'],
        sortable: ['rank'],
        searchable: ['name'],
      }),
    ).toEqual({
      filterableAttributes: ['group'],
      sortableAttributes: ['rank'],
      searchableAttributes: ['name'],
    });
  });

  it('defaults searchable to [], making the collection a plain key-value store', () => {
    // AGENTS.md §5: this is what keeps a non-corpus collection out of the inverted index.
    expect(settingsFor({ name: 'runs', primaryKey: 'run_id' })).toEqual({
      filterableAttributes: [],
      sortableAttributes: [],
      searchableAttributes: [],
    });
  });
});

describe('settingsMatch', () => {
  const desired = {
    filterableAttributes: ['group'],
    sortableAttributes: ['rank'],
    searchableAttributes: ['name'],
  };

  it('is true when the managed attributes already agree', () => {
    expect(settingsMatch({ ...desired, typoTolerance: { enabled: true } }, desired)).toBe(true);
  });

  it('ignores ordering, which Meilisearch does not preserve', () => {
    expect(
      settingsMatch({ ...desired, filterableAttributes: ['group'] }, { ...desired, filterableAttributes: ['group'] }),
    ).toBe(true);
  });

  it('is false when an attribute list differs', () => {
    expect(settingsMatch({ ...desired, sortableAttributes: [] }, desired)).toBe(false);
  });

  it('is false when the index reports nothing yet', () => {
    expect(settingsMatch({}, desired)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/cli/data-store.test.ts`
Expected: FAIL — `Failed to resolve import "./data-store"`.

Four typing details that only surface against the real `meilisearch@0.60.0`, recorded so a
re-run does not rediscover them:

- `meilisearch` must be a devDependency of `apps/workers`. `@keco/search` depends on it but
  does not re-export `Settings`, and pnpm's strict linking hides transitive types.
- `ManagedSettings` cannot be `Required<Pick<Settings, …>>`: in this version those fields are
  `(string | GranularFilterableAttribute)[] | null`, and `Required` strips optionality but not
  the null or the union. Declare the three `string[]` fields explicitly.
- `sameSet`'s "current" side takes `unknown` and compares via `.map(String)`. A live index can
  carry granular filterable objects, and anything richer than a plain string list must report
  "does not match" — never suppress a reindex that is genuinely needed.
- `getDocuments<Document>({…})` needs its generic pinned at both call sites; inference from a
  `fields` argument alone lands on `{}` and rejects `fields` as `never[]`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/cli/data-store.ts
import { createStorage } from '@keco/cache';
import { createAdminClient, type Meilisearch } from '@keco/search';
import type { Settings } from 'meilisearch';
import { config } from '../lib/config';
import {
  assertDocumentId,
  assertNonEmptyWhere,
  type CollectionSpec,
  type DataStore,
  type Document,
  type ListQuery,
  type Where,
} from '../lib/data-store';
import { FsDataStore } from '../lib/data-store.fs';
import { InMemoryDataStore } from '../lib/data-store.memory';

/**
 * The Meilisearch DataStore, and the factory that chooses an implementation.
 *
 * **This is the only file on a worker's path that knows a search engine exists.** Workers
 * take a `DataStore`; `handlers.ts` — the composition root — builds one here and injects it.
 * `eslint.config.mjs` enforces the rest of `apps/workers` cannot reach `@keco/search`.
 *
 * Meilisearch here is a *key-value and filter store*, not a read model. That distinction is
 * the whole basis of this design: AGENTS.md §4's "the projector is the only writer to
 * Meilisearch" governs the searchable read model (`tools`), and the projector is still its
 * only writer. See docs/adr/0002-discovery-datastore.md.
 */

/** How long a durable write may wait for its tasks before the sweep gives up on the store. */
const TASK_TIMEOUT_MS = 120_000;

/** Meilisearch pages `getDocuments` — this is the page size, not a result cap. */
const PAGE_SIZE = 1000;

/**
 * Meilisearch filter syntax, built from an equality-only predicate. Values are escaped rather
 * than interpolated raw: a repo description or a query slug is untrusted text, and an
 * unescaped quote turns a filter into a syntax error at best.
 */
export function toFilter(where: Where | undefined): string | undefined {
  if (where === undefined) return undefined;
  const clauses = Object.entries(where).map(([field, value]) =>
    typeof value === 'string'
      ? `${field} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : `${field} = ${String(value)}`,
  );
  return clauses.length === 0 ? undefined : clauses.join(' AND ');
}

/** `"field:direction"`, the shape `getDocuments` wants. */
const toSort = (sort: ListQuery['sort']): string[] | undefined =>
  sort === undefined ? undefined : sort.map(([field, direction]) => `${field}:${direction}`);

export type ManagedSettings = Required<
  Pick<Settings, 'filterableAttributes' | 'sortableAttributes' | 'searchableAttributes'>
>;

/**
 * Only the three lists this port models. Everything else about an index — ranking rules,
 * typo tolerance, pagination — is left exactly as found, so `ensure` can never clobber
 * settings someone applied deliberately.
 *
 * `searchableAttributes` defaults to `[]`, not to Meilisearch's `['*']`: a collection that
 * does not declare searchable fields is a plain key-value store (AGENTS.md §5), and
 * defaulting the other way would silently build an inverted index over every run record.
 */
export function settingsFor(spec: CollectionSpec): ManagedSettings {
  return {
    filterableAttributes: [...(spec.filterable ?? [])],
    sortableAttributes: [...(spec.sortable ?? [])],
    searchableAttributes: [...(spec.searchable ?? [])],
  };
}

const sameSet = (a: readonly string[] | null | undefined, b: readonly string[]): boolean =>
  a !== null && a !== undefined && a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Whether an index already has the settings we want. `ensure` runs at the start of every
 * sweep, and applying settings to a populated index *reindexes it* — 31k documents, every
 * run, for no change. Comparing first is what makes `ensure` genuinely idempotent rather
 * than merely repeatable.
 */
export function settingsMatch(current: Settings, desired: ManagedSettings): boolean {
  return (
    sameSet(current.filterableAttributes as string[] | undefined, desired.filterableAttributes) &&
    sameSet(current.sortableAttributes as string[] | undefined, desired.sortableAttributes) &&
    sameSet(current.searchableAttributes as string[] | undefined, desired.searchableAttributes)
  );
}

const isIndexNotFound = (error: unknown): boolean =>
  (error as { cause?: { code?: string } } | null)?.cause?.code === 'index_not_found';

export class MeilisearchDataStore implements DataStore {
  private readonly specs = new Map<string, CollectionSpec>();
  /** Task uids enqueued but not yet confirmed. Drained by the next durable put. */
  private pendingTaskUids: number[] = [];

  constructor(private readonly client: Meilisearch) {}

  async ensure(specs: readonly CollectionSpec[]): Promise<void> {
    for (const spec of specs) {
      this.specs.set(spec.name, spec);
      const desired = settingsFor(spec);

      let current: Settings | null = null;
      try {
        current = await this.client.index(spec.name).getSettings();
      } catch (error) {
        // Only "no such index" means missing. A bad key, a wrong host or a dead server all
        // reject too, and creating an index over one of those hides a real problem.
        if (!isIndexNotFound(error)) throw error;
        await this.client.createIndex(spec.name, { primaryKey: spec.primaryKey }).waitTask();
      }

      if (current !== null && settingsMatch(current, desired)) continue;
      await this.client.index(spec.name).updateSettings(desired).waitTask();
    }
  }

  async put(collection: string, documents: readonly Document[], options?: { durable?: boolean }): Promise<void> {
    // Synchronous, before any await — the port's deep-copy contract. The client does not
    // promise to serialise its body before yielding, and discovery hands us live arrays.
    const primaryKey = this.primaryKeyOf(collection);
    const copies = documents.map((document) => {
      const copy = structuredClone(document) as Document;
      assertDocumentId(copy[primaryKey], collection, primaryKey);
      return copy;
    });

    if (copies.length > 0) {
      const enqueued = await this.client.index(collection).updateDocuments(copies);
      this.pendingTaskUids.push(enqueued.taskUid);
    }
    if (options?.durable === true) await this.drain();
  }

  /**
   * Waits on every task enqueued since the last drain — not just the newest one. Waiting only
   * on the newest would assume Meilisearch processes tasks in enqueue order; that happens to
   * be true today, but discovery's corpus-then-state ordering guarantee is not something to
   * rest on an undocumented scheduler property. `waitForTasks` takes the whole set in one
   * call, so assuming nothing costs nothing.
   */
  private async drain(): Promise<void> {
    if (this.pendingTaskUids.length === 0) return;
    const uids = this.pendingTaskUids;
    this.pendingTaskUids = [];

    const tasks = await this.client.tasks.waitForTasks(uids, { timeout: TASK_TIMEOUT_MS, interval: 200 });
    const failed = tasks.filter((task) => task.status !== 'succeeded');
    if (failed.length > 0) {
      const detail = failed
        .map((task) => `${task.uid} ${task.status}: ${task.error?.message ?? 'unknown'}`)
        .join('; ');
      throw new Error(`meilisearch write failed — ${detail}`);
    }
  }

  async get(collection: string, id: string): Promise<Document | null> {
    try {
      return (await this.client.index(collection).getDocument(id)) as Document;
    } catch (error) {
      if ((error as { cause?: { code?: string } } | null)?.cause?.code === 'document_not_found') {
        return null;
      }
      // index_not_found is deliberately NOT swallowed. A missing collection is a programming
      // error — `ensure` runs at startup with a static list — and returning null for it would
      // make this the one implementation where a typo reads as an empty result.
      throw error;
    }
  }

  async count(collection: string, where?: Where): Promise<number> {
    // limit: 0 returns no documents and the real total — cardinality without streaming.
    const page = await this.client
      .index(collection)
      .getDocuments({ limit: 0, filter: toFilter(where) });
    return page.total;
  }

  async *list(collection: string, query: ListQuery = {}): AsyncIterable<Document> {
    const filter = toFilter(query.where);
    const sort = toSort(query.sort);
    let offset = 0;
    let yielded = 0;

    for (;;) {
      const remaining = query.limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, query.limit - yielded);
      if (remaining <= 0) return;

      const page = await this.client.index(collection).getDocuments({
        offset,
        limit: remaining,
        ...(filter === undefined ? {} : { filter }),
        ...(sort === undefined ? {} : { sort }),
        ...(query.fields === undefined ? {} : { fields: [...query.fields] }),
      });

      for (const row of page.results) {
        yield row as Document;
        yielded += 1;
      }

      offset += page.results.length;
      if (page.results.length === 0 || offset >= page.total) return;
    }
  }

  async remove(collection: string, where: Where): Promise<void> {
    // The shared guard, not a local throw: all three implementations must refuse an empty
    // filter identically, or the conformance suite is testing three different contracts.
    assertNonEmptyWhere(where, collection);
    // Unlike get/count/list, deleteDocuments enqueues a task rather than rejecting
    // synchronously — a missing index becomes a *failed task*, not a rejected promise, so
    // awaiting it without checking its status lets a typo'd collection resolve as a silent
    // no-op. Only a live server shows this: the fs and memory stores have no task queue.
    this.primaryKeyOf(collection);
    const task = await this.client
      .index<Document>(collection)
      .deleteDocuments({ filter: toFilter(where)! })
      .waitTask({ timeout: TASK_TIMEOUT_MS, interval: 200 });
    if (task.status !== 'succeeded') {
      throw new Error(
        `meilisearch remove failed for "${collection}": ${task.status} — ${task.error?.message ?? 'unknown'}`,
      );
    }
  }

  private primaryKeyOf(collection: string): string {
    const spec = this.specs.get(collection);
    if (spec === undefined) {
      throw new Error(`unknown collection "${collection}" — call ensure() first`);
    }
    return spec.primaryKey;
  }
}

/**
 * Builds the store the CLI injects into a worker. This is the *only* place the choice is
 * made — a worker cannot ask for a backend, because it cannot name one.
 */
export function createDataStore(env: NodeJS.ProcessEnv = process.env): DataStore {
  switch (config.DISCOVERY_STORE) {
    case 'memory':
      return new InMemoryDataStore();
    case 'fs':
      return new FsDataStore(createStorage({ dir: config.CACHE_DIR }));
    default:
      return new MeilisearchDataStore(createAdminClient(env));
  }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm vitest run apps/workers/src/cli/data-store.test.ts`
Expected: PASS, 10 tests.

If TypeScript complains that `config.DISCOVERY_STORE` does not exist, that is expected — it is
added in Task 10. Add it now if you prefer to keep `pnpm -F @keco/workers check` green between
tasks:

```ts
// apps/workers/src/lib/config.ts — inside the Env z.object, after CACHE_DIR
  /** Which DataStore implementation the CLI injects. Workers never read this. */
  DISCOVERY_STORE: z.enum(['meili', 'fs', 'memory']).default('meili'),
```

- [ ] **Step 5: Write the integration test**

```ts
// apps/workers/src/cli/data-store.integration.test.ts
import { createAdminClient } from '@keco/search';
import { afterAll, describe, expect, it } from 'vitest';
import { describeDataStore } from '../lib/data-store.conformance';
import { MeilisearchDataStore } from './data-store';

/**
 * Runs against the compose Meilisearch. Skipped unless MEILI_INTEGRATION=1, so `mise run ci`
 * stays hermetic — this is a `mise run test:integration` gate, not part of the default run.
 *
 * The conformance suite creates its collections under names prefixed for this file, and
 * afterAll deletes them. Meilisearch has no transactions and no per-test teardown, so the
 * suite is written to be run serially against a development instance — do not point
 * MEILI_HOST at anything you care about.
 */
const enabled = process.env.MEILI_INTEGRATION === '1';
const client = createAdminClient();

/** Named apart from anything a developer would create by hand. */
const PREFIX = 'it_datastore_';
const collections = [`${PREFIX}widgets`, `${PREFIX}notes`, `${PREFIX}durable`];

describe.skipIf(!enabled)('MeilisearchDataStore', () => {
  afterAll(async () => {
    for (const uid of collections) {
      await client.deleteIndex(uid).waitTask().catch(() => null);
    }
  });

  describeDataStore(
    'MeilisearchDataStore',
    async () => ({
      store: new MeilisearchDataStore(client),
      // The fs and memory harnesses hand every test a brand-new empty store. This one reuses
      // one real index across all 25 conformance tests, so without teardown later tests see
      // earlier tests' documents (measured: 11 failures — wrong counts, a non-empty "lists
      // nothing for an empty collection"). Clearing documents rather than deleting the index
      // keeps `ensure()`'s settings comparison short-circuiting instead of reindexing per test.
      close: async () => {
        for (const uid of [`${PREFIX}widgets`, `${PREFIX}notes`]) {
          await client.index(uid).deleteAllDocuments().waitTask();
        }
      },
    }),
    PREFIX,
  );

  it('a durable put confirms every earlier put, not just its own task', async () => {
    const uid = `${PREFIX}durable`;
    const store = new MeilisearchDataStore(client);
    await store.ensure([{ name: uid, primaryKey: 'id', filterable: ['kind'] }]);
    await store.remove(uid, { kind: 'repo' }).catch(() => null);

    // Corpus-shaped write: enqueued, deliberately not waited on.
    await store.put(uid, Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, kind: 'repo' })));
    // State-shaped write: durable. When this resolves the 500 must already be readable.
    await store.put(uid, [{ id: 'state', kind: 'state' }], { durable: true });

    expect(await store.count(uid, { kind: 'repo' })).toBe(500);
  });
});
```

- [ ] **Step 6: Run the integration test against a live Meilisearch**

```bash
mise run infra:up
MEILI_INTEGRATION=1 pnpm vitest run apps/workers/src/cli/data-store.integration.test.ts
```

Expected: PASS, 26 tests (25 conformance + the durability ordering test).

Then confirm it is skipped by default:

Run: `pnpm vitest run apps/workers/src/cli/data-store.integration.test.ts`
Expected: PASS with all tests reported as skipped.

- [ ] **Step 7: Commit**

```bash
git add apps/workers/src/cli/data-store.ts apps/workers/src/cli/data-store.test.ts \
        apps/workers/src/cli/data-store.integration.test.ts apps/workers/src/lib/config.ts
git commit -m "feat(workers): add MeilisearchDataStore in the CLI composition root

The only file on a worker's path that knows a search engine exists.
Workers take a DataStore; handlers.ts builds one here.

Two things worth reading twice. ensure() compares settings before
applying them, because applying settings to a populated index reindexes
it — 31k documents every sweep, for no change. And a durable put waits
on every task enqueued since the last drain rather than just the newest,
so the corpus-before-state ordering guarantee rests on nothing about
Meilisearch's scheduler."
```

---

## Phase 2 — Discovery data

### Task 6: Collections and mappers

**Files:**
- Create: `apps/workers/src/discovery/store/collections.ts`
- Test: `apps/workers/src/discovery/store/collections.test.ts`
- Modify: `packages/cache/src/keys.ts` (delete `discoveryKeys`, `slugifyQuery`, `bucketChar`, `MAX_SLUG_LENGTH`, `legacyDiscoveryStateKey`)
- Modify: `packages/cache/src/keys.test.ts` (delete the `discoveryKeys` describe block)

Pure data and pure functions: the three `CollectionSpec`s, the slug, the document ids, and
every mapper. Nothing here touches a `DataStore`, which is what makes it all trivially
testable.

`slugifyQuery` moves out of `@keco/cache` because it is discovery vocabulary, not a cache key
— and `discoveryKeys`, which was its only other caller, is being deleted.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/discovery/store/collections.test.ts
import type { SearchItem } from '@keco/github';
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_COLLECTIONS,
  REPOS,
  RUNS,
  STATE,
  repoDocumentId,
  slugifyQuery,
  toDetail,
  toRepoDocument,
  toRunDocument,
  toStateDocument,
} from './collections';

const item = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    id: 20038725,
    full_name: 'ahmetb/kubectx',
    name: 'kubectx',
    owner: { login: 'ahmetb' },
    description: 'Faster way to switch between clusters',
    homepage: 'https://kubectx.dev',
    stargazers_count: 18234,
    forks_count: 1180,
    open_issues_count: 41,
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
    topics: ['kubectl', 'kubernetes'],
    archived: false,
    fork: false,
    default_branch: 'master',
    created_at: '2014-05-22T12:00:00Z',
    updated_at: '2026-07-20T08:11:00Z',
    pushed_at: '2026-07-14T19:02:00Z',
    ...overrides,
  }) as SearchItem;

describe('slugifyQuery', () => {
  it('lowercases and collapses runs of non-alphanumerics to one hyphen', () => {
    expect(slugifyQuery('Kubernetes  Operator!')).toBe('kubernetes-operator');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugifyQuery('  kubernetes  ')).toBe('kubernetes');
  });

  it('refuses a query with no ASCII alphanumerics rather than sweeping into a nameless slug', () => {
    expect(() => slugifyQuery('日本語')).toThrow(/no ASCII alphanumeric/);
  });

  it('produces a slug that is a legal document id, so ids built from it cannot be rejected', () => {
    expect(slugifyQuery('kubernetes operator')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('repoDocumentId', () => {
  it('joins slug and numeric id with an underscore, never a colon', () => {
    // A colon is the obvious separator and Meilisearch rejects it as a primary key.
    expect(repoDocumentId('kubernetes', 20038725)).toBe('kubernetes_20038725');
  });

  it('cannot collide across queries, because repo ids are numeric', () => {
    expect(repoDocumentId('a-b', 1)).not.toBe(repoDocumentId('a', 1));
  });
});

describe('DISCOVERY_COLLECTIONS', () => {
  it('declares all three collections', () => {
    expect(DISCOVERY_COLLECTIONS.map((c) => c.name)).toEqual([REPOS, RUNS, STATE]);
  });

  it('makes runs and state plain key-value collections', () => {
    // AGENTS.md §5: searchable: [] is what keeps them out of the inverted index.
    for (const name of [RUNS, STATE]) {
      const spec = DISCOVERY_COLLECTIONS.find((c) => c.name === name)!;
      expect(spec.searchable ?? []).toEqual([]);
    }
  });

  it('makes every field a mapper filters or sorts on declared on the spec', () => {
    const repos = DISCOVERY_COLLECTIONS.find((c) => c.name === REPOS)!;
    expect(repos.filterable).toContain('query_slug');
    const runs = DISCOVERY_COLLECTIONS.find((c) => c.name === RUNS)!;
    expect(runs.filterable).toContain('query_slug');
    expect(runs.sortable).toContain('started_at');
  });
});

describe('toDetail', () => {
  it('flattens the search item into the documented shape', () => {
    const doc = toDetail(item(), 'kubernetes stars:>5000', '2026-08-02T09:30:00Z');
    expect(doc.owner).toBe('ahmetb');
    expect(doc.stars).toBe(18234);
    expect(doc.license).toBe('Apache-2.0');
    expect(doc.discovered_via).toBe('kubernetes stars:>5000');
    expect(doc.payload_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('excludes discovered_at from the hash, or every document would look changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item(), 'q', '2026-08-03T11:00:00Z');
    expect(a.payload_hash).toBe(b.payload_hash);
  });

  it('excludes discovered_via from the hash, so a subdivided window does not rewrite', () => {
    const a = toDetail(item(), 'kubernetes', '2026-08-02T09:30:00Z');
    const b = toDetail(item(), 'kubernetes created:2020..2021', '2026-08-02T09:30:00Z');
    expect(a.payload_hash).toBe(b.payload_hash);
  });

  it('includes stars, because the document asserts the star count', () => {
    const a = toDetail(item(), 'q', 'now');
    const b = toDetail(item({ stargazers_count: 99 }), 'q', 'now');
    expect(a.payload_hash).not.toBe(b.payload_hash);
  });
});

describe('toRepoDocument', () => {
  it('carries the query, slug and provenance run ids', () => {
    const detail = toDetail(item(), 'kubernetes', '2026-08-02T09:30:00Z');
    const doc = toRepoDocument(detail, {
      query: 'kubernetes',
      querySlug: 'kubernetes',
      runId: '01J0RUN2',
      firstSeenRunId: '01J0RUN1',
    });
    expect(doc.id).toBe('kubernetes_20038725');
    expect(doc.repo_id).toBe(20038725);
    expect(doc.query_slug).toBe('kubernetes');
    expect(doc.first_seen_run_id).toBe('01J0RUN1');
    expect(doc.last_seen_run_id).toBe('01J0RUN2');
  });

  it('keeps the GitHub id under repo_id, since id is now the composite key', () => {
    const detail = toDetail(item(), 'kubernetes', 'now');
    const doc = toRepoDocument(detail, {
      query: 'kubernetes',
      querySlug: 'kubernetes',
      runId: 'r',
      firstSeenRunId: 'r',
    });
    expect(doc.id).not.toBe(20038725);
    expect(doc.repo_id).toBe(20038725);
  });
});

describe('toStateDocument', () => {
  it('deep-copies the live arrays, so later mutation cannot reach the document', () => {
    // runDiscovery aliases state.pending_windows as its work queue and keeps mutating it.
    // The DataStore copies too, but doing it here as well means the document handed to the
    // store is already a snapshot — belt and braces on the one bug that loses windows.
    const pending = [{ base: 'kubernetes', stars: '>100', created: null }];
    const doc = toStateDocument(
      {
        query: 'kubernetes',
        started_at: 'now',
        pending_windows: pending,
        completed_windows: ['a'],
        failed_windows: [],
        repos_seen: 1,
        pages_fetched: 2,
        dropped: 0,
      },
      { querySlug: 'kubernetes', runId: 'r', now: new Date('2026-08-29T00:00:00Z') },
    );
    pending.push({ base: 'MUTATED', stars: '', created: null });
    expect(doc.pending_windows).toHaveLength(1);
  });

  it('keys on the slug, one document per query', () => {
    const doc = toStateDocument(
      {
        query: 'kubernetes',
        started_at: 'now',
        pending_windows: [],
        completed_windows: [],
        failed_windows: [],
        repos_seen: 0,
        pages_fetched: 0,
        dropped: 0,
      },
      { querySlug: 'kubernetes', runId: 'r', now: new Date('2026-08-29T00:00:00Z') },
    );
    expect(doc.query_slug).toBe('kubernetes');
    expect(doc.updated_at).toBe('2026-08-29T00:00:00.000Z');
  });
});

describe('toRunDocument', () => {
  const base = {
    runId: '01J0RUN',
    query: 'kubernetes',
    querySlug: 'kubernetes',
    startedAt: new Date('2026-08-29T03:00:00Z'),
    fresh: false,
    limit: null,
  };

  it('marks a freshly opened run as running, with no end', () => {
    const doc = toRunDocument({ ...base, outcome: 'running' });
    expect(doc.run_id).toBe('01J0RUN');
    expect(doc.outcome).toBe('running');
    expect(doc.ended_at).toBeNull();
    expect(doc.duration_ms).toBeNull();
  });

  it('computes duration from started_at and endedAt', () => {
    const doc = toRunDocument({
      ...base,
      outcome: 'complete',
      endedAt: new Date('2026-08-29T04:12:00Z'),
      counts: { new: 1204, changed: 8891, unchanged: 40 },
      pagesFetched: 742,
      dropped: 3,
      windowsCompleted: 318,
      windowsFailed: 0,
      sweepReposTotal: 31204,
      sweepWindowsPending: 0,
      stoppedAtLimit: false,
      failedWindows: [],
    });
    expect(doc.duration_ms).toBe(72 * 60 * 1000);
    expect(doc.repos_new).toBe(1204);
    expect(doc.pages_fetched).toBe(742);
  });

  it('caps failed_windows, so one catastrophic sweep cannot write an unbounded document', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ window: `w${i}`, error: 'boom' }));
    const doc = toRunDocument({
      ...base,
      outcome: 'failed',
      endedAt: new Date('2026-08-29T03:01:00Z'),
      counts: { new: 0, changed: 0, unchanged: 0 },
      pagesFetched: 1,
      dropped: 0,
      windowsCompleted: 0,
      windowsFailed: 120,
      sweepReposTotal: 0,
      sweepWindowsPending: 0,
      stoppedAtLimit: false,
      failedWindows: many,
    });
    expect(doc.failed_windows).toHaveLength(50);
    expect(doc.windows_failed).toBe(120);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/store/collections.test.ts`
Expected: FAIL — `Failed to resolve import "./collections"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/discovery/store/collections.ts
import { createHash } from 'node:crypto';
import type { SearchItem } from '@keco/github';
import type { CollectionSpec, Document } from '../../lib/data-store';
import type { Window } from '../windows';

/**
 * Discovery's data, declared as data (AGENTS.md §4.1). Nothing here touches a DataStore, a
 * backend or the network: it is the three collection specs, the slug, the document ids and
 * every mapper, all pure and all trivially testable.
 *
 * These are *write-model* collections. They are not a read model and nothing on the read side
 * queries them — see docs/adr/0002-discovery-datastore.md for why that distinction is what
 * makes this design legal under §2.
 */

export const REPOS = 'discovery_repos';
export const RUNS = 'discovery_runs';
export const STATE = 'discovery_state';

/**
 * `discovery_repos` is the one searchable collection, so a human or the backoffice can query
 * raw discovery output before it is ever projected. Note the port has no `search()` — this
 * declaration provisions the index; it does not give any worker a relevance query.
 *
 * `discovery_runs` and `discovery_state` declare `searchable: []`, which per AGENTS.md §5
 * makes them plain key-value stores: no inverted index, minimal RAM, still filterable.
 */
export const DISCOVERY_COLLECTIONS: readonly CollectionSpec[] = [
  {
    name: REPOS,
    primaryKey: 'id',
    searchable: ['name', 'full_name', 'description', 'topics'],
    filterable: ['query_slug', 'archived', 'fork', 'language'],
    sortable: ['stars', 'pushed_at'],
  },
  {
    name: RUNS,
    primaryKey: 'run_id',
    searchable: [],
    filterable: ['query_slug', 'outcome'],
    sortable: ['started_at', 'duration_ms', 'repos_new', 'pages_fetched'],
  },
  {
    name: STATE,
    primaryKey: 'query_slug',
    searchable: [],
    filterable: ['query_slug'],
    sortable: ['updated_at'],
  },
];

/**
 * Long enough for any real keyword, short enough to keep a composite document id well inside
 * every backend's key length limit.
 */
const MAX_SLUG_LENGTH = 100;

/**
 * `--query` is free text that becomes part of a document id, so it is a validation surface as
 * much as a naming one. Lowercase, collapse every run of non-alphanumerics to one `-`, trim,
 * truncate; anything left with no alphanumerics at all is refused.
 *
 * Deliberately lossy, so two queries CAN share one namespace — `kubernetes operator` and
 * `kubernetes-operator` both give `kubernetes-operator`. Accepted: colliding queries are
 * near-identical searches whose union is still a valid candidate corpus. A disambiguating
 * hash suffix would fix it at the cost of making every slug unguessable, which is a bad trade
 * for a value an operator types into `--query`.
 *
 * Moved here from packages/cache/src/keys.ts, which no longer has a discovery key to build.
 */
export function slugifyQuery(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  if (slug === '') {
    throw new Error(
      `discovery query ${JSON.stringify(query)} has no ASCII alphanumeric characters, so it ` +
        'has no collection namespace. Pass a keyword such as --query kubernetes.',
    );
  }
  return slug;
}

/**
 * Underscore, never a colon: document ids are `[A-Za-z0-9_-]` only (see `assertDocumentId`).
 * Slugs contain no underscores and repo ids are numeric, so `{slug}_{id}` cannot collide
 * between two queries.
 */
export const repoDocumentId = (querySlug: string, repoId: number): string =>
  `${querySlug}_${repoId}`;

// ── repo documents ───────────────────────────────────────────────────────────

export type DetailDoc = {
  repo_id: number;
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  language: string | null;
  license: string | null;
  topics: string[];
  archived: boolean;
  fork: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  discovered_via: string;
  discovered_at: string;
  payload_hash: string;
};

/**
 * Covers every field except `discovered_via`, `discovered_at` and `payload_hash` itself.
 *
 * `discovered_at` is excluded because including it would make every document look changed on
 * every run, defeating the rewrite policy outright.
 *
 * `discovered_via` is excluded because it is provenance, not content, and it is *unstable by
 * construction*: a window over 1000 results contributes its 100 probe items under the
 * parent's query and then subdivides, so a child window re-sees those repos under a different
 * query string. With `via` in the hash, a resumed sweep rewrote every one of them — measured
 * at 100 spurious `changed` documents on a 3000-repo corpus.
 *
 * `stars` IS included, unlike `contentHash` in @keco/cache which deliberately excludes it.
 * The two gate different things: `contentHash` gates expensive re-analysis, so star churn
 * must not trigger it; this hash gates a write whose whole content is that star count.
 */
export function toDetail(item: SearchItem, via: string, discoveredAt: string): DetailDoc {
  const content = {
    repo_id: item.id,
    full_name: item.full_name,
    name: item.name,
    owner: item.owner?.login ?? item.full_name.split('/')[0] ?? '',
    description: item.description ?? null,
    homepage: item.homepage ?? null,
    stars: item.stargazers_count,
    forks: item.forks_count,
    open_issues: item.open_issues_count,
    language: item.language ?? null,
    license: item.license?.spdx_id ?? null,
    topics: [...item.topics].sort(),
    archived: item.archived,
    fork: item.fork,
    default_branch: item.default_branch,
    created_at: item.created_at,
    updated_at: item.updated_at,
    pushed_at: item.pushed_at ?? null,
  };
  const payload_hash = createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
    .slice(0, 32);
  return { ...content, discovered_via: via, discovered_at: discoveredAt, payload_hash };
}

export type RepoDocumentContext = {
  query: string;
  querySlug: string;
  runId: string;
  /** The run that first saw this repo. Equals `runId` for a new repo. */
  firstSeenRunId: string;
};

export function toRepoDocument(detail: DetailDoc, context: RepoDocumentContext): Document {
  return {
    ...detail,
    id: repoDocumentId(context.querySlug, detail.repo_id),
    query: context.query,
    query_slug: context.querySlug,
    first_seen_run_id: context.firstSeenRunId,
    last_seen_run_id: context.runId,
  };
}

// ── state documents ──────────────────────────────────────────────────────────

export type FailedWindow = { window: string; error: string };

export type DiscoveryState = {
  query: string;
  started_at: string;
  /**
   * The live queue, serialised. Without it a resume loses every window produced by
   * subdivision: the parent is recorded complete and its children existed only in memory.
   */
  pending_windows: Window[];
  completed_windows: string[];
  failed_windows: FailedWindow[];
  repos_seen: number;
  /**
   * Pages asked for, not HTTP requests made: `SearchClient.page()` retries throttles
   * internally, so this reads low exactly when the budget is under the most pressure.
   */
  pages_fetched: number;
  /** Search items GitHub returned that failed per-item validation. Nothing drops silently. */
  dropped: number;
};

export function toStateDocument(
  state: DiscoveryState,
  context: { querySlug: string; runId: string; now: Date },
): Document {
  return {
    query_slug: context.querySlug,
    query: state.query,
    started_at: state.started_at,
    updated_at: context.now.toISOString(),
    current_run_id: context.runId,
    // structuredClone, not a spread: these are the arrays runDiscovery is actively mutating,
    // and a shallow copy of the *outer* array still shares every Window object inside it.
    pending_windows: structuredClone(state.pending_windows),
    completed_windows: [...state.completed_windows],
    failed_windows: structuredClone(state.failed_windows),
    repos_seen: state.repos_seen,
    pages_fetched: state.pages_fetched,
    dropped: state.dropped,
  };
}

// ── run documents ────────────────────────────────────────────────────────────

export type RunOutcome = 'running' | 'complete' | 'failed' | 'interrupted';

/**
 * One catastrophic sweep can fail every window it touches. The counter stays exact; the
 * detail list is capped so a run document cannot grow unbounded.
 */
const MAX_RECORDED_FAILED_WINDOWS = 50;

export type RunDocumentInput = {
  runId: string;
  query: string;
  querySlug: string;
  startedAt: Date;
  fresh: boolean;
  limit: number | null;
  outcome: RunOutcome;
  endedAt?: Date;
  counts?: { new: number; changed: number; unchanged: number };
  pagesFetched?: number;
  dropped?: number;
  windowsCompleted?: number;
  windowsFailed?: number;
  sweepReposTotal?: number;
  sweepWindowsPending?: number;
  stoppedAtLimit?: boolean;
  failedWindows?: readonly FailedWindow[];
};

export function toRunDocument(input: RunDocumentInput): Document {
  const endedAt = input.endedAt ?? null;
  return {
    run_id: input.runId,
    query: input.query,
    query_slug: input.querySlug,
    started_at: input.startedAt.toISOString(),
    ended_at: endedAt === null ? null : endedAt.toISOString(),
    duration_ms: endedAt === null ? null : endedAt.getTime() - input.startedAt.getTime(),
    outcome: input.outcome,
    fresh: input.fresh,
    limit: input.limit,
    // Run-scoped, never sweep-scoped: these count only this process. Reporting "742 pages"
    // when 742 covers two resumed runs is worse than reporting neither.
    pages_fetched: input.pagesFetched ?? 0,
    dropped: input.dropped ?? 0,
    repos_new: input.counts?.new ?? 0,
    repos_changed: input.counts?.changed ?? 0,
    repos_unchanged: input.counts?.unchanged ?? 0,
    windows_completed: input.windowsCompleted ?? 0,
    windows_failed: input.windowsFailed ?? 0,
    // Sweep-scoped snapshots, named apart so the two scopes are never confused.
    sweep_repos_total: input.sweepReposTotal ?? 0,
    sweep_windows_pending: input.sweepWindowsPending ?? 0,
    stopped_at_limit: input.stoppedAtLimit ?? false,
    failed_windows: (input.failedWindows ?? []).slice(0, MAX_RECORDED_FAILED_WINDOWS),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/store/collections.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Confirm nothing here broke anything else**

Run: `mise run ci`
Expected: green.

`slugifyQuery` now exists in two places — here and in `packages/cache/src/keys.ts`. That is
deliberate and temporary. **The `@keco/cache` copy is deleted in Task 10, not here**, because
`apps/workers/src/discovery/store.ts` still imports `discoveryKeys` and is not deleted until
then. Removing the keys now would leave `tsc` broken and `store.test.ts` unable to load for
four tasks — losing CI as a signal exactly while Tasks 7-9 build that file's replacement, and
switching off the ~47 tests currently protecting it.

Every task in this plan must leave `mise run ci` green. If one cannot, it is sequenced wrong.

- [ ] **Step 7: Commit**

```bash
git add apps/workers/src/discovery/store/collections.ts \
        apps/workers/src/discovery/store/collections.test.ts
git commit -m "feat(discovery): declare the three collections and their mappers

Pure data and pure functions — specs, slug, document ids, mappers.
Nothing here touches a DataStore, which is what makes it all testable
without one.

slugifyQuery is duplicated from @keco/cache rather than moved: the old
filesystem store still imports discoveryKeys and is not deleted until
Task 10, so removing it now would break the build for four tasks. The
GitHub repo id moves to repo_id because id is now the composite
{slug}_{repo_id} primary key."
```

---

### Task 7: Document schemas

**Files:**
- Create: `apps/workers/src/discovery/store/schemas.ts`
- Test: `apps/workers/src/discovery/store/schemas.test.ts`

Everything loaded from a `DataStore` is validated before use (AGENTS.md §13). These are the
schemas that do it, in their own file because `collections.ts` already owns the mappers and a
file that does both is the 525-line `store.ts` this task is dismantling.

The `z.ZodType<Created>` / `z.ZodType<Window>` annotations are load-bearing, not decoration: if
`windows.ts` grows a `Created` variant, this file fails to *compile* until the schema catches
up — the same belt-and-braces the taxonomy uses, so drift cannot silently start rejecting real
windows.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/discovery/store/schemas.test.ts
import { describe, expect, it } from 'vitest';
import { KnownRepoSchema, StateDocumentSchema } from './schemas';

const state = {
  query_slug: 'kubernetes',
  query: 'kubernetes',
  started_at: '2026-08-29T03:00:00.000Z',
  updated_at: '2026-08-29T03:10:00.000Z',
  current_run_id: '01J0RUN',
  pending_windows: [{ base: 'kubernetes', stars: '>100', created: { kind: 'year', year: 2020 } }],
  completed_windows: ['kubernetes stars:>100'],
  failed_windows: [{ window: 'w', error: 'boom' }],
  repos_seen: 3,
  pages_fetched: 4,
  dropped: 0,
};

describe('StateDocumentSchema', () => {
  it('accepts a well-formed state document', () => {
    expect(StateDocumentSchema.safeParse(state).success).toBe(true);
  });

  it('backfills a counter added after the fact, so an in-flight sweep still resumes', () => {
    // Rest-destructuring to omit trips no-unused-vars; deleting is the idiom this repo lints for.
    const older: Record<string, unknown> = { ...state };
    delete older.dropped;
    const parsed = StateDocumentSchema.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.dropped).toBe(0);
  });

  it('rejects an unknown window kind rather than resuming into nonsense', () => {
    const bad = { ...state, pending_windows: [{ base: 'k', stars: '>1', created: { kind: 'aeon' } }] };
    expect(StateDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a pending window with the wrong field types', () => {
    const bad = { ...state, pending_windows: [{ base: 1, stars: '>1', created: null }] };
    expect(StateDocumentSchema.safeParse(bad).success).toBe(false);
  });
});

describe('KnownRepoSchema', () => {
  it('accepts the three projected fields', () => {
    expect(
      KnownRepoSchema.safeParse({
        repo_id: 20038725,
        payload_hash: 'abc',
        first_seen_run_id: '01J0RUN',
      }).success,
    ).toBe(true);
  });

  it('rejects a row missing its hash, which would make the repo look unchanged forever', () => {
    expect(KnownRepoSchema.safeParse({ repo_id: 1, first_seen_run_id: 'r' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/store/schemas.test.ts`
Expected: FAIL — `Failed to resolve import "./schemas"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/discovery/store/schemas.ts
import { z } from 'zod';
import type { Created, Window } from '../windows';
import type { FailedWindow } from './collections';

/**
 * Validation for everything read back out of a DataStore (AGENTS.md §13). A document can have
 * been written by an older version of this code, hand-edited in the fs store, or truncated by
 * something outside this process — the store degrades rather than throwing, and these schemas
 * are what let it tell the difference between "resumable" and "start over".
 */

/**
 * Structural mirrors of `windows.ts`'s types. The `z.ZodType<…>` annotations are load-bearing:
 * add a `Created` variant or a `Window` field and this file fails to compile until the schema
 * catches up, rather than silently rejecting real windows at runtime.
 */
const CreatedSchema: z.ZodType<Created> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('years'), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('year'), year: z.number() }),
  z.object({ kind: z.literal('quarter'), year: z.number(), quarter: z.number() }),
  z.object({ kind: z.literal('month'), year: z.number(), month: z.number() }),
  z.object({ kind: z.literal('day'), date: z.string() }),
]);

const WindowSchema: z.ZodType<Window> = z.object({
  base: z.string(),
  stars: z.string(),
  created: CreatedSchema.nullable(),
});

const FailedWindowSchema: z.ZodType<FailedWindow> = z.object({
  window: z.string(),
  error: z.string(),
});

export const StateDocumentSchema = z.object({
  query_slug: z.string(),
  query: z.string(),
  started_at: z.string(),
  updated_at: z.string().default(''),
  current_run_id: z.string().default(''),
  pending_windows: z.array(WindowSchema),
  completed_windows: z.array(z.string()),
  failed_windows: z.array(FailedWindowSchema),
  repos_seen: z.number(),
  pages_fetched: z.number(),
  // `.default(0)`, not required: a counter added after the fact must not invalidate a state
  // document mid-sweep. zod backfills it, so an older document resumes instead of being
  // rejected and degraded to a full resweep.
  dropped: z.number().default(0),
});

export type StateDocument = z.infer<typeof StateDocumentSchema>;

/**
 * The projection the resume path reads — three fields out of a repo document, because
 * streaming 31k full documents to rebuild a hash map is the one avoidable cost at startup.
 */
export const KnownRepoSchema = z.object({
  repo_id: z.number(),
  payload_hash: z.string(),
  first_seen_run_id: z.string().default(''),
});

export type KnownRepo = z.infer<typeof KnownRepoSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/store/schemas.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/discovery/store/schemas.ts apps/workers/src/discovery/store/schemas.test.ts
git commit -m "feat(discovery): add document schemas for the DataStore reads

Everything read back is validated (AGENTS.md §13). The ZodType<Window>
annotation is deliberate: a new Created variant breaks the build here
rather than silently rejecting real windows at runtime."
```

---

### Task 8: `DiscoveryStore` — corpus, resume and flush

**Files:**
- Create: `apps/workers/src/discovery/store/store.ts`
- Test: `apps/workers/src/discovery/store/store.test.ts`

The data path. Run history is Task 9, which **edits this same class** — it is not a subclass,
so nothing here needs an extension point. This task's `open()` already takes a `runId` and
threads it through repo provenance; Task 9 adds the document that records the run itself.

Two things get simpler than the file being replaced:

- **One map instead of two.** The old store kept `entries` keyed by GitHub id and `hashes`
  keyed by `full_name`, and documented the desync that follows a repo rename as an accepted
  limitation. A single `Map<repo_id, {payload_hash, first_seen_run_id}>` has no second key to
  drift from.
- **Batched writes.** The old `record()` wrote one detail file per repo. That was free on a
  filesystem and is a round-trip per repo against anything else, so `record()` now buffers and
  `flush()` writes in batches — which is what §4 asks of every writer anyway.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/discovery/store/store.test.ts
import type { SearchItem } from '@keco/github';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataStore } from '../../lib/data-store';
import { InMemoryDataStore } from '../../lib/data-store.memory';
import { REPOS, STATE } from './collections';
import { DiscoveryStore } from './store';

const item = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    id: 20038725,
    full_name: 'ahmetb/kubectx',
    name: 'kubectx',
    owner: { login: 'ahmetb' },
    description: 'Faster way to switch between clusters',
    homepage: null,
    stargazers_count: 18234,
    forks_count: 1180,
    open_issues_count: 41,
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
    topics: ['kubectl'],
    archived: false,
    fork: false,
    default_branch: 'master',
    created_at: '2014-05-22T12:00:00Z',
    updated_at: '2026-07-20T08:11:00Z',
    pushed_at: '2026-07-14T19:02:00Z',
    ...overrides,
  }) as SearchItem;

const open = (data: DataStore, options: Parameters<typeof DiscoveryStore.open>[2] = {}) =>
  DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1', ...options });

const collect = async (iterable: AsyncIterable<Record<string, unknown>>) => {
  const out: Record<string, unknown>[] = [];
  for await (const row of iterable) out.push(row);
  return out;
};

describe('DiscoveryStore', () => {
  let data: DataStore;
  beforeEach(() => {
    data = new InMemoryDataStore();
  });

  it('records a new repo and writes it on flush, not before', async () => {
    const store = await open(data);
    expect(await store.record(item(), 'q')).toBe('new');
    // Buffered: a write per repo is a round-trip per repo against a real backend.
    expect(await data.count(REPOS)).toBe(0);

    await store.flush();
    expect(await data.count(REPOS)).toBe(1);
    const [doc] = await collect(data.list(REPOS));
    expect(doc).toMatchObject({
      id: 'kubernetes_20038725',
      repo_id: 20038725,
      query_slug: 'kubernetes',
      first_seen_run_id: 'RUN1',
      last_seen_run_id: 'RUN1',
    });
  });

  it('reports a repo already seen in this run as unchanged, without rewriting it', async () => {
    const store = await open(data);
    await store.record(item(), 'kubernetes');
    // A window over 1000 results contributes its probe items and then subdivides, so its
    // children re-yield the same repos. First window wins.
    expect(await store.record(item(), 'kubernetes created:2020..2021')).toBe('unchanged');
    await store.flush();

    const [doc] = await collect(data.list(REPOS));
    expect(doc!.discovered_via).toBe('kubernetes');
  });

  it('counts distinct known repos in size', async () => {
    const store = await open(data);
    await store.record(item(), 'q');
    await store.record(item({ id: 99, full_name: 'a/b', name: 'b' }), 'q');
    await store.record(item(), 'q');
    expect(store.size).toBe(2);
  });

  it('resumes: an unchanged payload is not rewritten on the next run', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    first.state.completed_windows.push('q');
    await first.flush();

    const second = await open(data, { runId: 'RUN2' });
    expect(second.size).toBe(1);
    expect(await second.record(item(), 'q')).toBe('unchanged');
    expect(second.state.completed_windows).toEqual(['q']);
  });

  it('resumes: a changed payload is rewritten, keeping its first_seen_run_id', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    first.state.completed_windows.push('q');
    await first.flush();

    const second = await open(data, { runId: 'RUN2' });
    expect(await second.record(item({ stargazers_count: 20000 }), 'q')).toBe('changed');
    await second.flush();

    const [doc] = await collect(data.list(REPOS));
    expect(doc).toMatchObject({
      stars: 20000,
      first_seen_run_id: 'RUN1',
      last_seen_run_id: 'RUN2',
    });
  });

  it('starts cold when there is no state, even if repo documents exist', async () => {
    // State is what says how far a sweep got; the corpus carries no progress of its own.
    // Loading a corpus whose progress this run cannot account for is worse than resweeping.
    await data.ensure((await import('./collections')).DISCOVERY_COLLECTIONS);
    await data.put(REPOS, [
      { id: 'kubernetes_1', repo_id: 1, query_slug: 'kubernetes', payload_hash: 'h' },
    ]);
    const store = await open(data);
    expect(store.size).toBe(0);
  });

  it('--fresh deletes this query, and only this query', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    await first.flush();
    await data.put(REPOS, [{ id: 'istio_7', repo_id: 7, query_slug: 'istio', payload_hash: 'h' }]);

    const second = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2', fresh: true });
    expect(second.size).toBe(0);
    expect(await data.count(REPOS, { query_slug: 'kubernetes' })).toBe(0);
    expect(await data.count(REPOS, { query_slug: 'istio' })).toBe(1);
    expect(await data.get(STATE, 'kubernetes')).toBeNull();
  });

  it('degrades to a fresh sweep when state fails validation, rather than wedging', async () => {
    const warnings: object[] = [];
    await data.ensure((await import('./collections')).DISCOVERY_COLLECTIONS);
    await data.put(STATE, [{ query_slug: 'kubernetes', query: 'kubernetes', pending_windows: 'no' }]);

    const store = await open(data, { logger: { warn: (fields) => warnings.push(fields) } });
    expect(store.size).toBe(0);
    expect(store.state.completed_windows).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('drops an unparseable corpus row without losing the rest', async () => {
    const first = await open(data);
    await first.record(item(), 'q');
    await first.flush();
    await data.put(REPOS, [{ id: 'kubernetes_5', query_slug: 'kubernetes' }]); // no payload_hash

    const second = await open(data, { runId: 'RUN2' });
    expect(second.size).toBe(1);
  });

  it('writes the corpus before the state document', async () => {
    // The ordering guarantee: state must never claim windows whose repos are not written.
    const order: string[] = [];
    // Delegate explicitly rather than spreading `data`: it is a class instance, so a spread
    // copies its private Maps and none of its methods.
    const spy: DataStore = {
      ensure: (specs) => data.ensure(specs),
      get: (c, id) => data.get(c, id),
      count: (c, w) => data.count(c, w),
      list: (c, q) => data.list(c, q),
      remove: (c, w) => data.remove(c, w),
      put: (c, d, o) => {
        order.push(`${c}${o?.durable === true ? ':durable' : ''}`);
        return data.put(c, d, o);
      },
    };
    const store = await DiscoveryStore.open(spy, 'kubernetes', { runId: 'RUN1' });
    order.length = 0;
    await store.record(item(), 'q');
    await store.flush();
    expect(order).toEqual([REPOS, `${STATE}:durable`]);
  });

  it('flushes on the 25th window, not before', async () => {
    const store = await open(data);
    const now = new Date('2026-08-29T00:00:00Z');
    for (let i = 1; i < 25; i += 1) {
      expect(await store.windowCompleted(now)).toBe(false);
    }
    expect(await store.windowCompleted(now)).toBe(true);
  });

  it('flushes once 30 seconds have passed, however few windows completed', async () => {
    const store = await open(data, { now: new Date('2026-08-29T00:00:00Z') });
    expect(await store.windowCompleted(new Date('2026-08-29T00:00:29Z'))).toBe(false);
    expect(await store.windowCompleted(new Date('2026-08-29T00:00:30Z'))).toBe(true);
  });

  it('serialises overlapping flushes', async () => {
    // The shutdown handler's flush and the loop's can be in flight at once; interleaving them
    // can persist a state that marks a window complete alongside a corpus missing its repos.
    const store = await open(data);
    await store.record(item(), 'q');
    await Promise.all([store.flush(), store.flush(), store.flush()]);
    expect(await data.count(REPOS)).toBe(1);
  });

  it('one failed flush does not poison every later one', async () => {
    let failNext = true;
    const spy: DataStore = {
      ensure: (specs) => data.ensure(specs),
      get: (c, id) => data.get(c, id),
      count: (c, w) => data.count(c, w),
      list: (c, q) => data.list(c, q),
      remove: (c, w) => data.remove(c, w),
      put: (c, d, o) => {
        if (c === REPOS && failNext) {
          failNext = false;
          return Promise.reject(new Error('backend down'));
        }
        return data.put(c, d, o);
      },
    };
    const store = await DiscoveryStore.open(spy, 'kubernetes', { runId: 'RUN1' });
    await store.record(item(), 'q');
    await expect(store.flush()).rejects.toThrow('backend down');
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/store/store.test.ts`
Expected: FAIL — `Failed to resolve import "./store"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/discovery/store/store.ts
import type { SearchItem } from '@keco/github';
import type { DataStore, Document } from '../../lib/data-store';
import {
  DISCOVERY_COLLECTIONS,
  REPOS,
  STATE,
  slugifyQuery,
  toDetail,
  toRepoDocument,
  toStateDocument,
  type DiscoveryState,
} from './collections';
import { KnownRepoSchema, StateDocumentSchema } from './schemas';

/**
 * Everything discovery reads and writes, over the `DataStore` port — no filesystem, no
 * backend, no key building. `collections.ts` owns the document shapes; this file owns the
 * bookkeeping: what counts as changed, which sighting wins, and when a flush is due.
 *
 * Two crash-safety properties it leans on, both provided by the port:
 *  - `put` deep-copies synchronously, so a live array being mutated by `runDiscovery` cannot
 *    be persisted half-written.
 *  - `put({durable: true})` resolves only when it *and every earlier put* is durable, which
 *    is what makes the corpus-then-state ordering below meaningful.
 *
 * Everything read back is still validated (AGENTS.md §13): atomicity says nothing about a
 * document written by an older version of this code or hand-edited in the fs store. `open()`
 * degrades — warns and starts a fresh sweep, or drops the bad rows — rather than throwing,
 * because a worker that needs a manual delete to restart is worse than a resweep.
 */

export type RecordOutcome = 'new' | 'changed' | 'unchanged';

export type DiscoveryLogger = { warn(fields: object, message: string): void };
const noopLogger: DiscoveryLogger = { warn: () => {} };

/**
 * What the resume path needs per repo. One map keyed by GitHub's numeric id, where the old
 * filesystem store kept two — `entries` by id and `hashes` by `full_name` — and documented
 * the desync after a repo rename as an accepted limitation. There is no second key to drift.
 */
type KnownRepo = { payload_hash: string; first_seen_run_id: string };

export type OpenOptions = {
  fresh?: boolean;
  now?: Date;
  logger?: DiscoveryLogger;
  /** Injected so tests are deterministic; `runDiscovery` lets it default to a fresh ULID. */
  runId?: string;
};

export class DiscoveryStore {
  /** Repos already recorded in this process — what makes first-wins hold *within* a run. */
  private readonly seenThisRun = new Set<number>();

  /** Documents recorded but not yet written. Drained by `flush`. */
  private pendingRepos: Document[] = [];

  /** Flush cadence: 25 windows or 30s, whichever comes first. See `windowCompleted`. */
  private static readonly FLUSH_WINDOW_COUNT = 25;
  private static readonly FLUSH_INTERVAL_MS = 30_000;
  /** Upsert batch size — AGENTS.md §4's "batches of ≤1000". */
  private static readonly WRITE_BATCH = 1000;

  private windowsSinceFlush = 0;
  private lastFlushAt: number;

  /**
   * Serialises overlapping `flush()` calls — the shutdown handler's and the loop's can be in
   * flight at once. Without it the two interleave *within* one flush, and if the earlier
   * flush's corpus write lands last you get a state marking a window complete alongside a
   * corpus missing its repos. Nothing would ever refetch them. The `.catch` is what stops one
   * failed flush poisoning every later one.
   */
  private flushing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dataStore: DataStore,
    private readonly query: string,
    readonly querySlug: string,
    private readonly known: Map<number, KnownRepo>,
    readonly state: DiscoveryState,
    readonly runId: string,
    openedAt: Date,
  ) {
    this.lastFlushAt = openedAt.getTime();
  }

  static async open(
    dataStore: DataStore,
    query: string,
    options: OpenOptions = {},
  ): Promise<DiscoveryStore> {
    const now = options.now ?? new Date();
    const logger = options.logger ?? noopLogger;
    // Throws for a query with no usable slug — before any I/O, so a hostile `--query` never
    // reaches the backend.
    const querySlug = slugifyQuery(query);
    const runId = options.runId ?? '';

    await dataStore.ensure(DISCOVERY_COLLECTIONS);

    if (options.fresh === true) {
      // `--fresh` deletes rather than merely ignoring. The filesystem store left orphaned
      // detail files behind and documented it as an accepted limitation; here the corpus is
      // one filterable collection, so a fresh sweep can genuinely start clean.
      await dataStore.remove(REPOS, { query_slug: querySlug });
      await dataStore.remove(STATE, { query_slug: querySlug });
    }

    const stored = options.fresh === true ? null : await loadState(dataStore, querySlug, logger);
    const known = new Map<number, KnownRepo>();

    if (stored !== null) {
      // Only load the corpus once there is validated state to resume: the corpus carries no
      // progress bookkeeping of its own, so state is what says how far the sweep got.
      // Unreadable state means a full resweep, not a best-effort partial load.
      let dropped = 0;
      for await (const row of dataStore.list(REPOS, {
        where: { query_slug: querySlug },
        fields: ['repo_id', 'payload_hash', 'first_seen_run_id'],
      })) {
        const parsed = KnownRepoSchema.safeParse(row);
        if (!parsed.success) {
          dropped += 1;
          continue;
        }
        known.set(parsed.data.repo_id, {
          payload_hash: parsed.data.payload_hash,
          first_seen_run_id: parsed.data.first_seen_run_id,
        });
      }
      if (dropped > 0) {
        logger.warn(
          { dropped, kept: known.size, collection: REPOS, query_slug: querySlug },
          'discovery: dropped malformed rows while loading the corpus',
        );
      }
    }

    const state: DiscoveryState = stored ?? {
      query,
      started_at: now.toISOString(),
      pending_windows: [],
      completed_windows: [],
      failed_windows: [],
      repos_seen: 0,
      pages_fetched: 0,
      dropped: 0,
    };

    return new DiscoveryStore(dataStore, query, querySlug, known, state, runId, now);
  }

  get size(): number {
    return this.known.size;
  }

  /**
   * Records one search hit, buffering its document only when the payload changed. The first
   * window to find a repo owns its `discovered_via`; later sightings are dropped.
   *
   * First-wins also means a document can be up to one sweep stale: if a repo changes between
   * its owning window recording it and a later window that would otherwise re-see it, the
   * fresher data is discarded for this sweep. Accepted — picking the "best" sighting needs a
   * definition of best this design does not have, and it self-heals on the next sweep.
   */
  async record(item: SearchItem, via: string, now = new Date()): Promise<RecordOutcome> {
    if (this.seenThisRun.has(item.id)) return 'unchanged';

    const detail = toDetail(item, via, now.toISOString());
    const known = this.known.get(detail.repo_id);
    if (known !== undefined && known.payload_hash === detail.payload_hash) {
      this.seenThisRun.add(detail.repo_id);
      return 'unchanged';
    }

    const firstSeenRunId = known?.first_seen_run_id === undefined || known.first_seen_run_id === ''
      ? this.runId
      : known.first_seen_run_id;

    this.pendingRepos.push(
      toRepoDocument(detail, {
        query: this.query,
        querySlug: this.querySlug,
        runId: this.runId,
        firstSeenRunId,
      }),
    );
    this.known.set(detail.repo_id, {
      payload_hash: detail.payload_hash,
      first_seen_run_id: firstSeenRunId,
    });
    this.seenThisRun.add(detail.repo_id);
    return known === undefined ? 'new' : 'changed';
  }

  /**
   * Call once a window's results have all been recorded — windows, not records, are the unit
   * the flush policy counts in, because a window is also the retry granularity: on resume an
   * incomplete window is refetched whole, so there is no finer notion of progress.
   *
   * The orchestrator owns *calling* this; it does not own *deciding* whether the call writes.
   * `flush()` stays available and is the unconditional path the orchestrator must use at
   * sweep end and around a caught error — "safe to kill at any moment" (§4) means the data
   * has to be durable before the process is allowed to exit, on every path out.
   *
   * Returns whether a flush actually ran, so a test can assert on it without reaching into
   * private counters.
   */
  async windowCompleted(now = new Date()): Promise<boolean> {
    this.windowsSinceFlush += 1;
    const due =
      this.windowsSinceFlush >= DiscoveryStore.FLUSH_WINDOW_COUNT ||
      now.getTime() - this.lastFlushAt >= DiscoveryStore.FLUSH_INTERVAL_MS;
    if (!due) return false;
    await this.flush(now);
    return true;
  }

  async flush(now = new Date()): Promise<void> {
    const turn = this.flushing.then(() => this.writeAll(now));
    this.flushing = turn.catch(() => undefined);
    return turn;
  }

  /**
   * Corpus first, then state — and state alone is `durable`. The order is load-bearing:
   * `state.completed_windows` is the resume decision, so it must never become durable ahead
   * of the repos it claims are recorded. `durable` means "this write and every earlier one",
   * so by the time the state put resolves the corpus batches are confirmed too. Reversing the
   * order would let state advance past repos that were never written: silently missing from
   * the corpus, with nothing to signal it.
   */
  private async writeAll(now: Date): Promise<void> {
    // Snapshot at the instant of the write, never cached from an earlier record().
    this.state.repos_seen = this.known.size;

    const batch = this.pendingRepos;
    this.pendingRepos = [];
    try {
      for (let i = 0; i < batch.length; i += DiscoveryStore.WRITE_BATCH) {
        await this.dataStore.put(REPOS, batch.slice(i, i + DiscoveryStore.WRITE_BATCH));
      }
    } catch (error) {
      // Put them back: a failed flush must not silently drop a window's repos, and the next
      // flush (or the one in `runDiscovery`'s finally) is the retry.
      this.pendingRepos = [...batch, ...this.pendingRepos];
      throw error;
    }

    await this.dataStore.put(
      STATE,
      [toStateDocument(this.state, { querySlug: this.querySlug, runId: this.runId, now })],
      { durable: true },
    );

    this.windowsSinceFlush = 0;
    this.lastFlushAt = now.getTime();
  }
}

/**
 * Reads the state document, validated. Returns `null` — never throws — for anything that is
 * not clean, schema-valid state. The caller treats `null` as "start a fresh sweep", which is
 * always safe: GitHub Search is the source of truth and this document is only ever a resume
 * optimisation.
 */
async function loadState(
  dataStore: DataStore,
  querySlug: string,
  logger: DiscoveryLogger,
): Promise<DiscoveryState | null> {
  const raw = await dataStore.get(STATE, querySlug);
  if (raw === null) return null;

  const result = StateDocumentSchema.safeParse(raw);
  if (!result.success) {
    logger.warn(
      { collection: STATE, query_slug: querySlug, issues: result.error.issues.slice(0, 5) },
      'discovery: state document failed validation — starting a fresh sweep instead of wedging',
    );
    return null;
  }

  const { query, started_at, pending_windows, completed_windows, failed_windows, repos_seen, pages_fetched, dropped } =
    result.data;
  return {
    query,
    started_at,
    pending_windows,
    completed_windows,
    failed_windows,
    repos_seen,
    pages_fetched,
    dropped,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/store/store.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/discovery/store/store.ts apps/workers/src/discovery/store/store.test.ts
git commit -m "feat(discovery): rewrite DiscoveryStore over the DataStore port

Two simplifications fall out of the move. One map keyed by repo id
replaces the old entries-by-id plus hashes-by-full_name pair, so the
desync after a repo rename — documented as an accepted limitation —
has no second key to drift from. And record() now buffers while flush()
writes in batches, because one write per repo is free on a filesystem
and a round-trip per repo against anything else.

--fresh deletes instead of merely ignoring, which is what fixes the
orphaned-detail-file limitation for good."
```

---

### Task 9: Run history

**Files:**
- Modify: `apps/workers/src/discovery/store/store.ts`
- Modify: `apps/workers/src/discovery/store/store.test.ts`
- Modify: `apps/workers/package.json` (add `ulid`)

The headline feature: every sweep leaves a durable record of what it did. `open()` writes it
immediately as `running`; `finishRun()` stamps the ending.

The counters that matter are **run-scoped**, and `state.pages_fetched` / `state.dropped` are
**sweep-scoped** — they accumulate across every resume. Snapshotting at `open()` and
subtracting is what keeps the two apart. Reporting "742 pages" when 742 covers two resumed
runs is worse than reporting neither.

- [ ] **Step 1: Add the `ulid` dependency**

```bash
pnpm -F @keco/workers add ulid
```

Run ids are ULIDs so `discovery_runs` sorts by time the way journal keys do (§3 of AGENTS.md),
and `ulid` is already a transitive dependency via `@keco/cache`'s journal.

- [ ] **Step 2: Write the failing test**

Append to `apps/workers/src/discovery/store/store.test.ts`:

```ts
import { RUNS } from './collections';

describe('DiscoveryStore run history', () => {
  let data: DataStore;
  beforeEach(() => {
    data = new InMemoryDataStore();
  });

  it('writes a running record the moment the store opens', async () => {
    await DiscoveryStore.open(data, 'kubernetes', {
      runId: 'RUN1',
      now: new Date('2026-08-29T03:00:00Z'),
      fresh: true,
      limit: 500,
    });

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({
      run_id: 'RUN1',
      query: 'kubernetes',
      query_slug: 'kubernetes',
      started_at: '2026-08-29T03:00:00.000Z',
      outcome: 'running',
      ended_at: null,
      duration_ms: null,
      fresh: true,
      limit: 500,
    });
  });

  it('generates a sortable run id when none is injected', async () => {
    const store = await DiscoveryStore.open(data, 'kubernetes', {});
    expect(store.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('finishRun stamps the ending and the run-scoped counters', async () => {
    const store = await DiscoveryStore.open(data, 'kubernetes', {
      runId: 'RUN1',
      now: new Date('2026-08-29T03:00:00Z'),
    });
    await store.record(item(), 'q');
    await store.record(item({ id: 2, full_name: 'a/b', name: 'b' }), 'q');
    await store.record(item(), 'q'); // already seen this run
    store.state.pages_fetched += 7;
    store.state.dropped += 1;
    store.state.completed_windows.push('w1', 'w2');

    await store.finishRun('complete', new Date('2026-08-29T04:12:00Z'));

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({
      outcome: 'complete',
      ended_at: '2026-08-29T04:12:00.000Z',
      duration_ms: 72 * 60 * 1000,
      repos_new: 2,
      repos_unchanged: 1,
      pages_fetched: 7,
      dropped: 1,
      windows_completed: 2,
      sweep_repos_total: 2,
    });
  });

  it('reports pages this run, not the sweep total carried in from a resume', async () => {
    const first = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    first.state.pages_fetched = 600;
    first.state.completed_windows.push('w1');
    await first.flush();
    await first.finishRun('interrupted');

    const second = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2' });
    expect(second.state.pages_fetched).toBe(600); // sweep-scoped, carried in
    second.state.pages_fetched += 42;
    await second.finishRun('complete');

    const run = await data.get(RUNS, 'RUN2');
    expect(run).toMatchObject({ pages_fetched: 42, sweep_windows_pending: 0 });
  });

  it('counts windows completed by this run, not by the sweep', async () => {
    const first = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    first.state.completed_windows.push('w1', 'w2', 'w3');
    await first.flush();
    await first.finishRun('interrupted');

    const second = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2' });
    second.state.completed_windows.push('w4');
    await second.finishRun('complete');

    expect(await data.get(RUNS, 'RUN2')).toMatchObject({ windows_completed: 1 });
  });

  it('records failed windows and the stopped-at-limit flag', async () => {
    const store = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    store.state.failed_windows.push({ window: 'w', error: 'boom' });
    await store.finishRun('failed', undefined, { stoppedAtLimit: true });

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({
      outcome: 'failed',
      windows_failed: 1,
      stopped_at_limit: true,
      failed_windows: [{ window: 'w', error: 'boom' }],
    });
  });

  it('leaves a killed run at running, rather than rewriting history', async () => {
    // A SIGKILL never reaches finishRun. The stuck row IS the signal that a sweep died
    // without cleanup — quietly repairing it would hide the failure someone is looking for.
    await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    const later = await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2' });
    await later.finishRun('complete');

    expect(await data.get(RUNS, 'RUN1')).toMatchObject({ outcome: 'running' });
    expect(await data.count(RUNS)).toBe(2);
  });

  it('--fresh keeps the run history, which nothing else can reconstruct', async () => {
    await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN1' });
    await DiscoveryStore.open(data, 'kubernetes', { runId: 'RUN2', fresh: true });
    expect(await data.count(RUNS, { query_slug: 'kubernetes' })).toBe(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/store/store.test.ts -t "run history"`
Expected: FAIL — `store.finishRun is not a function`.

- [ ] **Step 4: Edit `store.ts`**

Add these imports:

```ts
import { ulid } from 'ulid';
import {
  DISCOVERY_COLLECTIONS,
  REPOS,
  RUNS,
  STATE,
  slugifyQuery,
  toDetail,
  toRepoDocument,
  toRunDocument,
  toStateDocument,
  type DiscoveryState,
  type RunOutcome,
} from './collections';
```

Extend `OpenOptions`:

```ts
export type OpenOptions = {
  fresh?: boolean;
  now?: Date;
  logger?: DiscoveryLogger;
  /** Injected so tests are deterministic; defaults to a fresh ULID. */
  runId?: string;
  /** Recorded on the run document so history explains a short sweep. */
  limit?: number | null;
};
```

Add these fields to the class, beside `seenThisRun`:

```ts
  /** Write outcomes for THIS process, as opposed to the sweep counters on `state`. */
  private readonly runCounts = { new: 0, changed: 0, unchanged: 0 };

  /**
   * Sweep-scoped counters as they stood when this process opened. Subtracting gives the
   * run-scoped numbers the history reports — `state.pages_fetched` accumulates across every
   * resume, and reporting a two-run total as one run's cost is worse than reporting nothing.
   */
  private readonly openedWith: {
    pagesFetched: number;
    dropped: number;
    windowsCompleted: number;
    windowsFailed: number;
  };
```

Replace the constructor signature's tail and body so it takes the run metadata:

```ts
  private constructor(
    private readonly dataStore: DataStore,
    private readonly query: string,
    readonly querySlug: string,
    private readonly known: Map<number, KnownRepo>,
    readonly state: DiscoveryState,
    readonly runId: string,
    private readonly startedAt: Date,
    private readonly fresh: boolean,
    private readonly limit: number | null,
  ) {
    this.lastFlushAt = startedAt.getTime();
    this.openedWith = {
      pagesFetched: state.pages_fetched,
      dropped: state.dropped,
      windowsCompleted: state.completed_windows.length,
      windowsFailed: state.failed_windows.length,
    };
  }
```

In `open()`, replace `const runId = options.runId ?? '';` with:

```ts
    const runId = options.runId ?? ulid();
```

and replace the `return new DiscoveryStore(...)` with:

```ts
    const store = new DiscoveryStore(
      dataStore,
      query,
      querySlug,
      known,
      state,
      runId,
      now,
      options.fresh === true,
      options.limit ?? null,
    );

    // Written immediately, not at the end: a sweep that is killed still leaves evidence it
    // started, and `outcome: 'running'` in the history is exactly how an operator spots one
    // that never finished.
    await store.writeRun('running');
    return store;
  }
```

In `record()`, count the outcome before returning it. Replace the three `return` statements:

```ts
    if (this.seenThisRun.has(item.id)) {
      this.runCounts.unchanged += 1;
      return 'unchanged';
    }
```

```ts
    if (known !== undefined && known.payload_hash === detail.payload_hash) {
      this.seenThisRun.add(detail.repo_id);
      this.runCounts.unchanged += 1;
      return 'unchanged';
    }
```

```ts
    this.seenThisRun.add(detail.repo_id);
    const outcome = known === undefined ? 'new' : 'changed';
    this.runCounts[outcome] += 1;
    return outcome;
```

Add the two new methods after `writeAll`:

```ts
  /**
   * Stamps the run's ending. Called on every path out of `runDiscovery` — normal completion,
   * a failed-window exit, and the shutdown handler.
   *
   * A `SIGKILL` never reaches here, so that run stays `running` in the history forever. That
   * is deliberate: the stuck row is the signal a sweep died without cleanup, and a later run
   * quietly repairing it would hide exactly the failure someone is looking for.
   */
  async finishRun(
    outcome: Exclude<RunOutcome, 'running'>,
    now = new Date(),
    extra: { stoppedAtLimit?: boolean } = {},
  ): Promise<void> {
    await this.writeRun(outcome, now, extra);
  }

  private async writeRun(
    outcome: RunOutcome,
    now?: Date,
    extra: { stoppedAtLimit?: boolean } = {},
  ): Promise<void> {
    await this.dataStore.put(
      RUNS,
      [
        toRunDocument({
          runId: this.runId,
          query: this.query,
          querySlug: this.querySlug,
          startedAt: this.startedAt,
          fresh: this.fresh,
          limit: this.limit,
          outcome,
          ...(outcome === 'running' ? {} : { endedAt: now ?? new Date() }),
          counts: { ...this.runCounts },
          pagesFetched: this.state.pages_fetched - this.openedWith.pagesFetched,
          dropped: this.state.dropped - this.openedWith.dropped,
          windowsCompleted: this.state.completed_windows.length - this.openedWith.windowsCompleted,
          windowsFailed: this.state.failed_windows.length - this.openedWith.windowsFailed,
          sweepReposTotal: this.known.size,
          sweepWindowsPending: this.state.pending_windows.length,
          stoppedAtLimit: extra.stoppedAtLimit ?? false,
          failedWindows: this.state.failed_windows,
        }),
      ],
      // Durable: the history is the one collection nothing can reconstruct, and a run record
      // lost to a crash is a sweep that never happened as far as anyone can tell.
      { durable: true },
    );
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run apps/workers/src/discovery/store/store.test.ts`
Expected: PASS, 22 tests (14 from Task 8 + 8 new).

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/discovery/store/store.ts \
        apps/workers/src/discovery/store/store.test.ts \
        apps/workers/package.json pnpm-lock.yaml
git commit -m "feat(discovery): record a document per sweep run

open() writes it as running; finishRun() stamps the ending. A SIGKILL
leaves the row at running forever, deliberately — that stuck row is how
an operator spots a sweep that died without cleanup, and repairing it
later would hide the failure.

Run-scoped counters come from snapshotting the sweep-scoped ones at
open and subtracting, so a resumed sweep never reports two runs' pages
as one run's cost."
```

---

## Phase 3 — Wiring

### Task 10: `runDiscovery` takes the dependency

**Files:**
- Modify: `apps/workers/src/discovery/index.ts`
- Modify: `apps/workers/src/lib/config.ts`
- Delete: `apps/workers/src/discovery/store.ts`, `apps/workers/src/discovery/store.test.ts`

The orchestrator stops building its own storage and receives it. Its local `outcomes`
bookkeeping goes away — `record()` already counts, so the store owns it.

- [ ] **Step 1: Delete the old store, and the cache keys only it used**

```bash
git rm apps/workers/src/discovery/store.ts apps/workers/src/discovery/store.test.ts
```

Now — and only now, because this was that file's last caller — delete from
`packages/cache/src/keys.ts`: `bucketChar`, `MAX_SLUG_LENGTH`, `slugifyQuery`,
`discoveryKeys`, `DiscoveryKeys` and `legacyDiscoveryStateKey`, i.e. everything from the
`/** Discovery output (design 2026-08-02) … */` comment to the end of the file. Keep
`repoKeys`, `externalKey`, `analysisKey`, `journalKey`, `journalDayPrefix`, `checkpointKey`
and `dayOf`. Delete the matching `describe('discoveryKeys', …)` block from
`packages/cache/src/keys.test.ts`.

This resolves the temporary duplication Task 6 left: `slugifyQuery` now lives only in
`discovery/store/collections.ts`, where it belongs.

Verify nothing else referenced them:

Run: `grep -rn "discoveryKeys\|legacyDiscoveryStateKey" apps packages --include="*.ts"`
Expected: no matches. Any hit is a caller this plan missed.

- [ ] **Step 2: Add the config key** (skip if you already added it in Task 5)

In `apps/workers/src/lib/config.ts`, inside the `Env` object after `CACHE_DIR`:

```ts
  /**
   * Which DataStore implementation the CLI injects. Read only by
   * `apps/workers/src/cli/data-store.ts` — a worker cannot name a backend, let alone pick one.
   */
  DISCOVERY_STORE: z.enum(['meili', 'fs', 'memory']).default('meili'),
```

- [ ] **Step 3: Edit `discovery/index.ts`**

Replace the imports of `createRuntime` and the old store:

```ts
import { SearchClient, type SearchItem } from '@keco/github';
import { config } from '../lib/config';
import type { DataStore } from '../lib/data-store';
import { workerLogger } from '../lib/logger';
import { createProgress } from '../lib/progress';
import { installShutdown } from '../lib/shutdown';
import { MAX_RESULTS_PER_QUERY, PER_PAGE, planWindow } from './plan';
import { DiscoveryStore } from './store/store';
import { beginSweep } from './sweep';
import { queryOf } from './windows';
```

Change the signature and the store construction:

```ts
export type DiscoveryOptions = {
  query: string;
  /** `null` means no limit. Validated as a positive integer by the CLI. */
  limit: number | null;
  fresh: boolean;
};

/**
 * The DataStore arrives as a dependency rather than being built here. That is the whole
 * point of the port: this file cannot name a backend, so it cannot accidentally couple to
 * one. `apps/workers/src/cli/handlers.ts` is the only place that chooses.
 */
export type DiscoveryDeps = { dataStore: DataStore };

export async function runDiscovery(
  { query, limit, fresh }: DiscoveryOptions,
  { dataStore }: DiscoveryDeps,
): Promise<void> {
  if (config.GITHUB_TOKEN === '') {
    log.error('GITHUB_TOKEN is required for discovery — unauthenticated search is 10 req/min');
    process.exitCode = 1;
    return;
  }

  const now = new Date();

  const store = await DiscoveryStore.open(dataStore, query, { fresh, now, limit, logger: log });
  const search = SearchClient.fromToken(config.GITHUB_TOKEN, { logger: log });
  const progress = createProgress({ log });
```

Delete the `const { cache } = createRuntime();` line and the `outcomes` declaration:

```ts
  // DELETE:
  // const outcomes: Record<RecordOutcome, number> = { new: 0, changed: 0, unchanged: 0 };
```

Change the shutdown wiring so an interrupted run is recorded as such:

```ts
  installShutdown({
    log,
    flush: async () => {
      await store.flush();
      // The history has to say the sweep was interrupted, or a killed run is
      // indistinguishable from one that is still going.
      await store.finishRun('interrupted');
    },
    done: () => progress.done(),
  });
```

Simplify `recordAll` — it no longer accumulates:

```ts
async function recordAll(
  store: DiscoveryStore,
  items: readonly SearchItem[],
  via: string,
): Promise<void> {
  for (const item of items) {
    try {
      await store.record(item, via);
    } catch (error) {
      log.warn(
        { repo: item.full_name, error: error instanceof Error ? error.message : String(error) },
        'could not record repo',
      );
    }
  }
}
```

and update its three call sites to drop the `outcomes` argument:

```ts
          await recordAll(store, probe.items, q);
```
```ts
            await recordAll(store, next.items, q);
```

Finally, replace the summary block at the end of the function:

```ts
  const failed = store.state.failed_windows.length;
  const summary = {
    // `sweep_` fields accumulate across every resume; `run_` fields cover only this process.
    // They are not comparable, so they are not named alike.
    run_id: store.runId,
    sweep_repos: store.size,
    sweep_windows_completed: completed.size,
    sweep_windows_failed: failed,
    sweep_windows_pending: queue.length,
    sweep_pages_fetched: store.state.pages_fetched,
    sweep_dropped_items: store.state.dropped,
    stopped_at_limit: stopped,
  };

  if (failed > 0) {
    // A failed window is a silently truncated corpus: it is dropped from the queue, is not
    // retried in-run, and only returns on the next full sweep. Exiting 0 would let a
    // scheduled sweep hand the crawler an incomplete corpus and call it a success.
    await store.finishRun('failed', new Date(), { stoppedAtLimit: stopped });
    process.exitCode = 1;
    log.error(
      { ...summary, failed_windows: store.state.failed_windows },
      'discovery finished with failed windows — the corpus is incomplete',
    );
    return;
  }

  await store.finishRun('complete', new Date(), { stoppedAtLimit: stopped });
  log.info(summary, 'discovery complete');
}
```

The per-run write counts are no longer logged here because they now live in the run document,
where `kecoctl discovery list runs` can show them across sweeps rather than in one log line.

- [ ] **Step 4: Typecheck**

Run: `pnpm -F @keco/workers check`
Expected: two errors, both in `cli/handlers.ts` and `cli/program.test.ts` — `runDiscovery`
now takes two arguments. Task 11 fixes them.

- [ ] **Step 5: Commit**

```bash
git add -A apps/workers/src/discovery apps/workers/src/lib/config.ts
git commit -m "refactor(discovery): take the DataStore as a dependency

runDiscovery no longer builds its own storage — it cannot name a
backend, so it cannot couple to one. The local new/changed/unchanged
bookkeeping goes too: record() already counts, and the numbers now live
in the run document where the history can show them across sweeps.

The shutdown handler records outcome: interrupted, so a killed sweep is
distinguishable from one still running."
```

---

### Task 11: Wire the composition root

> **Done as part of Task 10.** Deleting the old store broke `tsc`, and this plan requires every
> task to leave `mise run ci` green, so Task 10 applied the `discoverySweep` wiring itself
> rather than commit red. It also had to repoint `sweep.ts`/`sweep.test.ts`, which imported
> `DiscoveryState` from the deleted file — an unlisted casualty this plan missed. The
> end-to-end smoke test below was run and passed: a live `--query istio --limit 30 --fresh`
> sweep wrote 42 repo documents, 1 state document and 1 run document to Meilisearch, with the
> run reporting `repos_new: 42`, `duration_ms: 6019`, `pages_fetched: 3`.

**Files:**
- Modify: `apps/workers/src/cli/handlers.ts`
- Modify: `apps/workers/src/cli/program.test.ts`

- [ ] **Step 1: Fix the handler**

In `apps/workers/src/cli/handlers.ts`, replace the `discoverySweep` line:

```ts
  discoverySweep: async (options) => {
    // The one place a backend is chosen. Kept as a dynamic import for the same reason every
    // other dependency here is: a static graph would load the Meilisearch client for
    // `kecoctl --help`.
    const { createDataStore } = await import('./data-store');
    const { runDiscovery } = await import('../discovery');
    await runDiscovery(options, { dataStore: createDataStore() });
  },
```

- [ ] **Step 2: Fix the program test's stub**

`program.test.ts` builds a `Handlers` object of stubs. `discoverySweep` still takes one
argument there — `buildProgram` calls `handlers.discoverySweep(options)` and knows nothing
about deps — so this should already compile. Run it to confirm:

Run: `pnpm vitest run apps/workers/src/cli/program.test.ts`
Expected: PASS. If it fails, the stub's signature drifted; match it to
`(options: DiscoveryOptions) => Promise<void>`.

- [ ] **Step 3: Typecheck and run the full suite**

Run: `pnpm -F @keco/workers check && pnpm vitest run apps/workers`
Expected: both PASS.

- [ ] **Step 4: Smoke-test end to end**

```bash
mise run infra:up
GITHUB_TOKEN=$GITHUB_TOKEN mise run discovery:sweep -- --query kubernetes --limit 50 --fresh
```

Expected: the sweep runs, the progress bar advances, and the final log line carries `run_id`.
Confirm the three collections exist and hold data:

```bash
curl -s -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  "http://localhost:7700/indexes/discovery_runs/documents?limit=1" | head -40
```

Expected: one run document with `outcome: "complete"`, a non-null `duration_ms`, and
`repos_new` matching roughly the number swept.

Then confirm resume writes nothing new:

```bash
GITHUB_TOKEN=$GITHUB_TOKEN mise run discovery:sweep -- --query kubernetes --limit 50
```

Expected: a second run document whose `repos_new` is 0 and `repos_unchanged` is non-zero —
the definition of done from the original discovery design, now visible in the history rather
than needing a `stat` over the cache.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/cli/handlers.ts apps/workers/src/cli/program.test.ts
git commit -m "feat(workers): inject the DataStore from the CLI composition root

handlers.ts is the only place a backend is chosen. Kept as a dynamic
import like every other dependency here, so kecoctl --help does not
load the Meilisearch client."
```

---

## Phase 4 — Explore

### Task 12: `discovery count`

**Files:**
- Create: `apps/workers/src/discovery/explore.ts`
- Test: `apps/workers/src/discovery/explore.test.ts`

Data access only — rendering is Task 13. Everything goes through `DataStore`, so these
commands keep working under `DISCOVERY_STORE=fs`.

The query list comes from `discovery_state`, one document per query. That is the only cheap
way to enumerate distinct queries: the port has no `distinct` and no facets, and scanning
31k repo documents to learn there are two queries would be absurd.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/discovery/explore.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { DataStore } from '../lib/data-store';
import { InMemoryDataStore } from '../lib/data-store.memory';
import { DISCOVERY_COLLECTIONS, REPOS, RUNS, STATE } from './store/collections';
import { countDiscovery } from './explore';

const seed = async (data: DataStore) => {
  await data.ensure(DISCOVERY_COLLECTIONS);
  await data.put(STATE, [
    {
      query_slug: 'kubernetes',
      query: 'kubernetes',
      pending_windows: [{ base: 'k', stars: '>1', created: null }, { base: 'k', stars: '>2', created: null }],
      updated_at: '2026-08-28T03:14:00.000Z',
    },
    { query_slug: 'istio', query: 'istio', pending_windows: [], updated_at: '2026-08-27T22:01:00.000Z' },
  ]);
  await data.put(REPOS, [
    { id: 'kubernetes_1', repo_id: 1, query_slug: 'kubernetes', stars: 10, full_name: 'a/one', language: 'Go' },
    { id: 'kubernetes_2', repo_id: 2, query_slug: 'kubernetes', stars: 30, full_name: 'a/two', language: 'Go' },
    { id: 'istio_3', repo_id: 3, query_slug: 'istio', stars: 5, full_name: 'b/three', language: 'Rust' },
  ]);
  await data.put(RUNS, [
    { run_id: 'R1', query_slug: 'kubernetes', started_at: '2026-08-27T03:14:00.000Z', outcome: 'complete', repos_new: 2 },
    { run_id: 'R2', query_slug: 'kubernetes', started_at: '2026-08-28T03:14:00.000Z', outcome: 'interrupted', repos_new: 0 },
    { run_id: 'R3', query_slug: 'istio', started_at: '2026-08-27T22:01:00.000Z', outcome: 'complete', repos_new: 1 },
  ]);
};

describe('countDiscovery', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('reports one row per query, ordered by slug for a stable table', async () => {
    const rows = await countDiscovery(data, { query: null });
    expect(rows.map((r) => r.query_slug)).toEqual(['istio', 'kubernetes']);
  });

  it('counts repos, runs and pending windows per query', async () => {
    const [, kubernetes] = await countDiscovery(data, { query: null });
    expect(kubernetes).toMatchObject({
      query: 'kubernetes',
      repos: 2,
      runs: 2,
      pending_windows: 2,
    });
  });

  it('reports the most recent run, not the first', async () => {
    const [, kubernetes] = await countDiscovery(data, { query: null });
    expect(kubernetes!.last_run).toMatchObject({ run_id: 'R2', outcome: 'interrupted' });
  });

  it('narrows to one query when asked', async () => {
    const rows = await countDiscovery(data, { query: 'istio' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ query_slug: 'istio', repos: 1, runs: 1 });
  });

  it('returns an empty list when nothing has been swept', async () => {
    const empty = new InMemoryDataStore();
    await empty.ensure(DISCOVERY_COLLECTIONS);
    expect(await countDiscovery(empty, { query: null })).toEqual([]);
  });

  it('reports a query with state but no runs rather than omitting it', async () => {
    // A sweep killed before its first flush leaves exactly this. Hiding it would hide the
    // thing an operator is looking for.
    await data.put(STATE, [{ query_slug: 'argo', query: 'argo', pending_windows: [] }]);
    const rows = await countDiscovery(data, { query: null });
    expect(rows.find((r) => r.query_slug === 'argo')).toMatchObject({
      repos: 0,
      runs: 0,
      last_run: null,
    });
  });

  it('narrowing to an unswept query returns nothing, not a throw', async () => {
    expect(await countDiscovery(data, { query: 'never-swept' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/explore.test.ts`
Expected: FAIL — `Failed to resolve import "./explore"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/discovery/explore.ts
import type { DataStore, Document } from '../lib/data-store';
import { REPOS, RUNS, STATE, slugifyQuery } from './store/collections';

/**
 * `kecoctl discovery count | list | reset` — reading and clearing the discovery dataset.
 *
 * Data access only; `explore-format.ts` renders. Everything goes through the `DataStore`
 * port, never a backend, so all three commands keep working under `DISCOVERY_STORE=fs` —
 * which also means the whole module is testable against `InMemoryDataStore`.
 */

export type LastRun = { run_id: string; started_at: string; outcome: string };

export type CountRow = {
  query: string;
  query_slug: string;
  repos: number;
  runs: number;
  pending_windows: number;
  last_run: LastRun | null;
};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/**
 * The set of swept queries comes from `discovery_state`, one document per query. It is the
 * only cheap enumeration available: the port has no `distinct` and no facets, and scanning
 * the repo collection to learn that two queries exist would read 31k documents for a number.
 *
 * The consequence is that a query is listed from the moment its first sweep opens, before any
 * repo or run document lands. That is correct — a sweep killed in its first seconds is
 * exactly what someone runs this command to find.
 */
export async function countDiscovery(
  dataStore: DataStore,
  options: { query: string | null },
): Promise<CountRow[]> {
  const slug = options.query === null ? null : slugifyQuery(options.query);

  const states: Document[] = [];
  for await (const row of dataStore.list(STATE, slug === null ? {} : { where: { query_slug: slug } })) {
    states.push(row);
  }
  // Ordered by slug: a table whose row order changes between runs is a table nobody trusts.
  states.sort((a, b) => (asString(a.query_slug) < asString(b.query_slug) ? -1 : 1));

  const rows: CountRow[] = [];
  for (const state of states) {
    const querySlug = asString(state.query_slug);
    const where = { query_slug: querySlug };
    rows.push({
      query: asString(state.query, querySlug),
      query_slug: querySlug,
      repos: await dataStore.count(REPOS, where),
      runs: await dataStore.count(RUNS, where),
      pending_windows: Array.isArray(state.pending_windows) ? state.pending_windows.length : 0,
      last_run: await lastRunOf(dataStore, querySlug),
    });
  }
  return rows;
}

async function lastRunOf(dataStore: DataStore, querySlug: string): Promise<LastRun | null> {
  for await (const row of dataStore.list(RUNS, {
    where: { query_slug: querySlug },
    sort: [['started_at', 'desc']],
    fields: ['run_id', 'started_at', 'outcome'],
    limit: 1,
  })) {
    return {
      run_id: asString(row.run_id),
      started_at: asString(row.started_at),
      outcome: asString(row.outcome, 'unknown'),
    };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/explore.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/discovery/explore.ts apps/workers/src/discovery/explore.test.ts
git commit -m "feat(discovery): add countDiscovery

Enumerates queries from discovery_state, the only cheap way to learn
which queries exist — the port has no distinct and no facets, and
scanning 31k repo documents for that number would be absurd.

A query appears from the moment its first sweep opens, before any repo
or run document lands. That is deliberate: a sweep killed in its first
seconds is what someone runs this to find."
```

---

### Task 13: `discovery list`

**Files:**
- Modify: `apps/workers/src/discovery/explore.ts`
- Modify: `apps/workers/src/discovery/explore.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/workers/src/discovery/explore.test.ts`:

```ts
import { listRepos, listRuns, resolveSort } from './explore';

describe('resolveSort', () => {
  it('defaults runs to newest first', () => {
    expect(resolveSort(RUNS, null)).toEqual([['started_at', 'desc']]);
  });

  it('defaults repos to most stars first', () => {
    expect(resolveSort(REPOS, null)).toEqual([['stars', 'desc']]);
  });

  it('accepts a declared sortable field', () => {
    expect(resolveSort(RUNS, 'duration_ms')).toEqual([['duration_ms', 'desc']]);
  });

  it('accepts an explicit direction', () => {
    expect(resolveSort(REPOS, 'stars:asc')).toEqual([['stars', 'asc']]);
  });

  it('rejects an undeclared field by name, listing what is available', () => {
    // Silently ignoring it would show a table that looks sorted and is not.
    expect(() => resolveSort(RUNS, 'nonsense')).toThrow(/nonsense/);
    expect(() => resolveSort(RUNS, 'nonsense')).toThrow(/started_at/);
  });

  it('rejects a direction that is neither asc nor desc', () => {
    expect(() => resolveSort(RUNS, 'started_at:sideways')).toThrow(/sideways/);
  });
});

describe('listRuns', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('returns the newest runs first, across all queries by default', async () => {
    const { rows, total } = await listRuns(data, { query: null, limit: 10, sort: null });
    expect(rows.map((r) => r.run_id)).toEqual(['R2', 'R3', 'R1']);
    expect(total).toBe(3);
  });

  it('narrows to one query', async () => {
    const { rows, total } = await listRuns(data, { query: 'istio', limit: 10, sort: null });
    expect(rows.map((r) => r.run_id)).toEqual(['R3']);
    expect(total).toBe(1);
  });

  it('caps at the limit but still reports the true total', async () => {
    // "showing 2 of 3" is the whole point — a capped table that lies about the total is worse
    // than no table.
    const { rows, total } = await listRuns(data, { query: null, limit: 2, sort: null });
    expect(rows).toHaveLength(2);
    expect(total).toBe(3);
  });
});

describe('listRepos', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('returns the most-starred first', async () => {
    const { rows } = await listRepos(data, { query: null, limit: 10, sort: null });
    expect(rows.map((r) => r.full_name)).toEqual(['a/two', 'a/one', 'b/three']);
  });

  it('caps at the limit and reports the true total', async () => {
    const { rows, total } = await listRepos(data, { query: 'kubernetes', limit: 1, sort: null });
    expect(rows).toHaveLength(1);
    expect(total).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/explore.test.ts`
Expected: FAIL — `resolveSort is not exported`.

- [ ] **Step 3: Extend `explore.ts`**

Add these imports and exports:

```ts
import { DISCOVERY_COLLECTIONS, REPOS, RUNS, STATE, slugifyQuery } from './store/collections';
import type { Sort } from '../lib/data-store';

/** The default ordering per collection: newest runs, biggest repos. */
const DEFAULT_SORT: Record<string, Sort> = {
  [RUNS]: [['started_at', 'desc']],
  [REPOS]: [['stars', 'desc']],
};

/**
 * Turns `--sort` into a `Sort`, refusing anything the collection did not declare sortable.
 *
 * Rejecting by name matters more than it looks: a backend given an undeclared sort field
 * either errors deep in a client stack or quietly returns unsorted results, and the second
 * failure shows the operator a table that looks sorted and is not.
 */
export function resolveSort(collection: string, sort: string | null): Sort {
  if (sort === null) return DEFAULT_SORT[collection] ?? [];

  const spec = DISCOVERY_COLLECTIONS.find((candidate) => candidate.name === collection);
  const sortable = spec?.sortable ?? [];
  const [field = '', direction = 'desc'] = sort.split(':');

  if (!sortable.includes(field)) {
    throw new Error(
      `cannot sort ${collection} by "${field}" — sortable fields are: ${sortable.join(', ')}`,
    );
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error(`sort direction must be asc or desc, got "${direction}"`);
  }
  return [[field, direction]];
}

export type ListOptions = { query: string | null; limit: number; sort: string | null };
export type ListResult = { rows: Document[]; total: number };

/**
 * `total` is the count *before* the limit, so the caller can say "showing 20 of 31,204". A
 * capped table that reports its own length as the total is worse than no table.
 */
async function listCollection(
  dataStore: DataStore,
  collection: string,
  options: ListOptions,
): Promise<ListResult> {
  const where =
    options.query === null ? undefined : { query_slug: slugifyQuery(options.query) };

  const rows: Document[] = [];
  for await (const row of dataStore.list(collection, {
    ...(where === undefined ? {} : { where }),
    sort: resolveSort(collection, options.sort),
    limit: options.limit,
  })) {
    rows.push(row);
  }

  return { rows, total: await dataStore.count(collection, where) };
}

export const listRuns = (dataStore: DataStore, options: ListOptions): Promise<ListResult> =>
  listCollection(dataStore, RUNS, options);

export const listRepos = (dataStore: DataStore, options: ListOptions): Promise<ListResult> =>
  listCollection(dataStore, REPOS, options);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/explore.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/discovery/explore.ts apps/workers/src/discovery/explore.test.ts
git commit -m "feat(discovery): add listRuns and listRepos

--sort is validated against the collection's declared sortable fields
and rejected by name. An undeclared field either errors deep in a client
stack or quietly returns unsorted rows, and the second failure shows a
table that looks sorted and is not.

total is counted before the limit so the caller can say 'showing 20 of
31,204'."
```

---

### Task 14: `discovery reset` and its guards

**Files:**
- Modify: `apps/workers/src/discovery/explore.ts`
- Modify: `apps/workers/src/discovery/explore.test.ts`

Every guard here is a way to not lose data by accident, so each one gets its own test.

- [ ] **Step 1: Write the failing test**

Append to `apps/workers/src/discovery/explore.test.ts`:

```ts
import { applyReset, planReset } from './explore';

describe('planReset', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('refuses with no target rather than defaulting to everything', async () => {
    // A reset that defaults to every query is a reset that eventually runs by accident.
    await expect(planReset(data, { query: null, all: false, includeRuns: false })).rejects.toThrow(
      /--query|--all/,
    );
  });

  it('plans one query when named', async () => {
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: false });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ query_slug: 'kubernetes', repos: 2, state: 1, runs: 2 });
  });

  it('plans every query under --all', async () => {
    const plans = await planReset(data, { query: null, all: true, includeRuns: false });
    expect(plans.map((p) => p.query_slug)).toEqual(['istio', 'kubernetes']);
  });

  it('reports runs as kept by default and deleted under --include-runs', async () => {
    const keep = await planReset(data, { query: 'kubernetes', all: false, includeRuns: false });
    expect(keep[0]!.delete_runs).toBe(false);
    const wipe = await planReset(data, { query: 'kubernetes', all: false, includeRuns: true });
    expect(wipe[0]!.delete_runs).toBe(true);
  });

  it('plans an unswept query as a no-op rather than throwing', async () => {
    const plans = await planReset(data, { query: 'never-swept', all: false, includeRuns: false });
    expect(plans).toEqual([]);
  });
});

describe('applyReset', () => {
  let data: DataStore;
  beforeEach(async () => {
    data = new InMemoryDataStore();
    await seed(data);
  });

  it('deletes the corpus and state, keeping the run history', async () => {
    // The history is the one collection nothing can reconstruct — not from the cache, not
    // from GitHub — and a reset is when someone most wants to read it.
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: false });
    await applyReset(data, plans);

    expect(await data.count(REPOS, { query_slug: 'kubernetes' })).toBe(0);
    expect(await data.get(STATE, 'kubernetes')).toBeNull();
    expect(await data.count(RUNS, { query_slug: 'kubernetes' })).toBe(2);
  });

  it('deletes the history too under --include-runs', async () => {
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: true });
    await applyReset(data, plans);
    expect(await data.count(RUNS, { query_slug: 'kubernetes' })).toBe(0);
  });

  it('leaves every other query untouched', async () => {
    const plans = await planReset(data, { query: 'kubernetes', all: false, includeRuns: true });
    await applyReset(data, plans);
    expect(await data.count(REPOS, { query_slug: 'istio' })).toBe(1);
    expect(await data.get(STATE, 'istio')).not.toBeNull();
  });

  it('is the same deletion --fresh performs', async () => {
    // reset --query X and sweep --fresh must not drift into meaning different things.
    const { DiscoveryStore } = await import('./store/store');
    const other = new InMemoryDataStore();
    await seed(other);

    await applyReset(data, await planReset(data, { query: 'kubernetes', all: false, includeRuns: false }));
    await DiscoveryStore.open(other, 'kubernetes', { runId: 'RUN9', fresh: true });

    expect(await other.count(REPOS, { query_slug: 'kubernetes' })).toBe(
      await data.count(REPOS, { query_slug: 'kubernetes' }),
    );
    expect(await other.get(STATE, 'kubernetes')).toEqual(await data.get(STATE, 'kubernetes'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/explore.test.ts`
Expected: FAIL — `planReset is not exported`.

- [ ] **Step 3: Extend `explore.ts`**

```ts
export type ResetOptions = { query: string | null; all: boolean; includeRuns: boolean };

export type ResetPlan = {
  query: string;
  query_slug: string;
  repos: number;
  state: number;
  runs: number;
  delete_runs: boolean;
};

/**
 * Works out what a reset would destroy, without destroying anything. The CLI prints this and
 * then asks — an operator confirms against what is actually there, not against what they
 * assumed was there.
 *
 * Refuses with no target: `--query` names one, `--all` means every query, and there is no
 * default. A reset that defaults to everything is a reset that eventually runs by accident,
 * and unlike the read model this data is not rebuildable offline.
 */
export async function planReset(
  dataStore: DataStore,
  options: ResetOptions,
): Promise<ResetPlan[]> {
  if (options.query === null && !options.all) {
    throw new Error(
      'refusing to reset without a target — pass --query <keyword> for one query, or --all for every query',
    );
  }

  const rows = await countDiscovery(dataStore, { query: options.query });
  return rows.map((row) => ({
    query: row.query,
    query_slug: row.query_slug,
    repos: row.repos,
    state: 1,
    runs: row.runs,
    delete_runs: options.includeRuns,
  }));
}

/**
 * Applies a plan. Corpus first, then state, then — only if asked — the history.
 *
 * State goes after the corpus for the same reason a flush writes it last: if this is
 * interrupted halfway, a surviving state document pointing at a partly-deleted corpus is
 * recoverable (the next sweep re-records what is missing), whereas a deleted state document
 * over a surviving corpus would strand 31k rows that nothing will ever clean up.
 */
export async function applyReset(dataStore: DataStore, plans: readonly ResetPlan[]): Promise<void> {
  for (const plan of plans) {
    const where = { query_slug: plan.query_slug };
    await dataStore.remove(REPOS, where);
    await dataStore.remove(STATE, where);
    if (plan.delete_runs) await dataStore.remove(RUNS, where);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/explore.test.ts`
Expected: PASS, 27 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/discovery/explore.ts apps/workers/src/discovery/explore.test.ts
git commit -m "feat(discovery): add reset, planned before it is applied

planReset works out what would be destroyed without destroying it, so
the CLI can print real counts and then ask. Refuses without --query or
--all: a reset that defaults to every query is one that eventually runs
by accident, and this data is not rebuildable offline.

Run history survives by default. It is the one collection nothing can
reconstruct, and a reset is when someone most wants to read it."
```

---

### Task 15: Rendering

**Files:**
- Create: `apps/workers/src/discovery/explore-format.ts`
- Test: `apps/workers/src/discovery/explore-format.test.ts`

Pure functions from data to strings. Separated from `explore.ts` so both stay small and so
the table layout can be tested without a `DataStore` at all.

- [ ] **Step 1: Write the failing test**

```ts
// apps/workers/src/discovery/explore-format.test.ts
import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration, formatRepos, formatRuns, ndjson, table } from './explore-format';

describe('table', () => {
  it('pads columns to the widest cell, including the header', () => {
    const lines = table([{ NAME: 'a', N: '1' }, { NAME: 'bbbb', N: '22' }]).split('\n');
    expect(lines[0]).toBe('NAME   N');
    expect(lines[1]).toBe('a      1');
    expect(lines[2]).toBe('bbbb  22');
  });

  it('right-aligns numeric columns so digits line up', () => {
    const lines = table([{ N: '1' }, { N: '1000' }]).split('\n');
    expect(lines[1]).toBe('   1');
    expect(lines[2]).toBe('1000');
  });

  it('returns an empty string for no rows, so a caller can print its own message', () => {
    expect(table([])).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders hours and minutes', () => {
    expect(formatDuration(72 * 60 * 1000)).toBe('1h12m');
  });

  it('renders minutes alone under an hour', () => {
    expect(formatDuration(58 * 60 * 1000)).toBe('58m');
  });

  it('renders seconds under a minute, so a fast run is not reported as 0m', () => {
    expect(formatDuration(4_000)).toBe('4s');
  });

  it('renders a dash for a run that has not ended', () => {
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatCount', () => {
  it('renders one row per query with thousands separators', () => {
    const out = formatCount([
      {
        query: 'kubernetes',
        query_slug: 'kubernetes',
        repos: 31204,
        runs: 47,
        pending_windows: 118,
        last_run: { run_id: 'R', started_at: '2026-08-28T03:14:00.000Z', outcome: 'complete' },
      },
    ]);
    expect(out).toContain('31,204');
    expect(out).toContain('kubernetes');
    expect(out).toContain('complete');
  });

  it('says so plainly when nothing has been swept', () => {
    expect(formatCount([])).toMatch(/no discovery data/i);
  });
});

describe('formatRuns', () => {
  const run = {
    run_id: 'R1',
    started_at: '2026-08-28T03:14:00.000Z',
    duration_ms: 72 * 60 * 1000,
    outcome: 'complete',
    repos_new: 1204,
    repos_changed: 8891,
    pages_fetched: 742,
    windows_completed: 318,
    windows_failed: 0,
  };

  it('shows the numbers the history exists to answer', () => {
    const out = formatRuns({ rows: [run], total: 1 });
    expect(out).toContain('1,204'); // new repos
    expect(out).toContain('742'); // GitHub Search calls
    expect(out).toContain('1h12m'); // duration
  });

  it('adds a showing-N-of-M line only when the list was capped', () => {
    expect(formatRuns({ rows: [run], total: 1 })).not.toMatch(/showing/);
    expect(formatRuns({ rows: [run], total: 47 })).toMatch(/showing 1 of 47/);
  });

  it('says so plainly when there are no runs', () => {
    expect(formatRuns({ rows: [], total: 0 })).toMatch(/no runs/i);
  });
});

describe('formatRepos', () => {
  it('renders stars, name, language and a relative push time', () => {
    const out = formatRepos(
      { rows: [{ full_name: 'a/one', stars: 112034, language: 'Go', pushed_at: '2026-08-27T00:00:00.000Z' }], total: 1 },
      new Date('2026-08-29T00:00:00.000Z'),
    );
    expect(out).toContain('112,034');
    expect(out).toContain('a/one');
    expect(out).toContain('2d ago');
  });
});

describe('ndjson', () => {
  it('emits one JSON object per line', () => {
    expect(ndjson([{ a: 1 }, { a: 2 }])).toBe('{"a":1}\n{"a":2}');
  });

  it('emits nothing for no rows, so a pipe sees an empty stream', () => {
    expect(ndjson([])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/explore-format.test.ts`
Expected: FAIL — `Failed to resolve import "./explore-format"`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/workers/src/discovery/explore-format.ts
import type { Document } from '../lib/data-store';
import type { CountRow, ListResult } from './explore';

/**
 * Rendering for the explore commands. Pure: data in, strings out, no DataStore and no I/O —
 * which is what lets the table layout be tested without a backend.
 *
 * These strings go to **stdout**; pino keeps stderr, the same split the progress bar already
 * uses. A query command's output is its result, not a log line, and `--json` has to pipe into
 * `jq` cleanly.
 */

const number = (value: unknown): string =>
  typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? '');

const text = (value: unknown, fallback = '—'): string =>
  typeof value === 'string' && value !== '' ? value : fallback;

/** A column is right-aligned when every one of its cells is a number. */
const isNumeric = (cells: readonly string[]): boolean =>
  cells.every((cell) => /^[\d,]*$/.test(cell));

export function table(rows: readonly Record<string, string>[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const alignRight = columns.map((column, i) =>
    isNumeric(rows.map((row) => row[column] ?? '')) && rows.some((row) => (row[column] ?? '') !== ''),
  );

  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (alignRight[i] === true ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();

  return [render(columns), ...rows.map((row) => render(columns.map((c) => row[c] ?? '')))].join('\n');
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

const shortTime = (iso: unknown): string =>
  typeof iso === 'string' && iso !== '' ? iso.slice(0, 16).replace('T', ' ') : '—';

const relative = (iso: unknown, now: Date): string => {
  if (typeof iso !== 'string' || iso === '') return '—';
  const ms = now.getTime() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(0, Math.floor(ms / 60_000))}m ago`;
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export function formatCount(rows: readonly CountRow[]): string {
  if (rows.length === 0) {
    return 'no discovery data — run `kecoctl discovery sweep --query <keyword>` first';
  }
  const body = table(
    rows.map((row) => ({
      QUERY: row.query,
      REPOS: number(row.repos),
      RUNS: number(row.runs),
      // Pending windows is what says whether a sweep finished or is mid-resume, so it earns
      // a column rather than living behind a flag.
      'PENDING WINDOWS': number(row.pending_windows),
      'LAST SWEEP': row.last_run === null ? '—' : shortTime(row.last_run.started_at),
      OUTCOME: row.last_run?.outcome ?? '—',
    })),
  );
  if (rows.length === 1) return body;
  const totals = rows.reduce(
    (acc, row) => ({ repos: acc.repos + row.repos, runs: acc.runs + row.runs }),
    { repos: 0, runs: 0 },
  );
  return `${body}\n\ntotals  ${number(totals.repos)} repos, ${number(totals.runs)} runs`;
}

const showing = (result: ListResult): string =>
  result.rows.length < result.total
    ? `\n\nshowing ${number(result.rows.length)} of ${number(result.total)} — raise with --limit, or pipe --json`
    : '';

export function formatRuns(result: ListResult): string {
  if (result.rows.length === 0) return 'no runs yet';
  const body = table(
    result.rows.map((row) => ({
      STARTED: shortTime(row.started_at),
      DUR: formatDuration(typeof row.duration_ms === 'number' ? row.duration_ms : null),
      OUTCOME: text(row.outcome),
      NEW: number(row.repos_new),
      CHANGED: number(row.repos_changed),
      PAGES: number(row.pages_fetched),
      WINDOWS: `${number(row.windows_completed)}${
        typeof row.windows_failed === 'number' && row.windows_failed > 0
          ? ` (${number(row.windows_failed)} failed)`
          : ''
      }`,
    })),
  );
  return body + showing(result);
}

export function formatRepos(result: ListResult, now = new Date()): string {
  if (result.rows.length === 0) return 'no repos discovered yet';
  const body = table(
    result.rows.map((row) => ({
      STARS: number(row.stars),
      REPO: text(row.full_name),
      LANG: text(row.language),
      PUSHED: relative(row.pushed_at, now),
    })),
  );
  return body + showing(result);
}

/** One JSON object per line — streams into `jq` without buffering the corpus. */
export const ndjson = (rows: readonly Document[]): string =>
  rows.map((row) => JSON.stringify(row)).join('\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/explore-format.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/discovery/explore-format.ts apps/workers/src/discovery/explore-format.test.ts
git commit -m "feat(discovery): render the explore commands

Pure data-to-strings, separate from explore.ts so the table layout is
testable without a DataStore. Output goes to stdout while pino keeps
stderr — the split the progress bar already uses, and what makes --json
pipe into jq cleanly.

The showing-N-of-M line appears only when the list was actually capped."
```

---

### Task 16: Wire the three commands into `kecoctl`

**Files:**
- Modify: `apps/workers/src/cli/program.ts`
- Modify: `apps/workers/src/cli/program.test.ts`
- Modify: `apps/workers/src/cli/handlers.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/workers/src/cli/program.test.ts`, following the stub pattern already there:

```ts
describe('discovery count | list | reset', () => {
  it('parses count with no flags', async () => {
    const calls: unknown[] = [];
    const program = buildProgram({ ...stubs, discoveryCount: async (o) => void calls.push(o) });
    await program.parseAsync(['discovery', 'count'], { from: 'user' });
    expect(calls[0]).toEqual({ query: null, json: false });
  });

  it('parses count --query', async () => {
    const calls: unknown[] = [];
    const program = buildProgram({ ...stubs, discoveryCount: async (o) => void calls.push(o) });
    await program.parseAsync(['discovery', 'count', '--query', 'istio'], { from: 'user' });
    expect(calls[0]).toMatchObject({ query: 'istio' });
  });

  it('defaults list to runs', async () => {
    const calls: unknown[] = [];
    const program = buildProgram({ ...stubs, discoveryList: async (o) => void calls.push(o) });
    await program.parseAsync(['discovery', 'list'], { from: 'user' });
    expect(calls[0]).toEqual({ target: 'runs', query: null, limit: 20, sort: null, json: false });
  });

  it('accepts repos as the list target', async () => {
    const calls: unknown[] = [];
    const program = buildProgram({ ...stubs, discoveryList: async (o) => void calls.push(o) });
    await program.parseAsync(['discovery', 'list', 'repos', '--limit', '5'], { from: 'user' });
    expect(calls[0]).toMatchObject({ target: 'repos', limit: 5 });
  });

  it('rejects a list target that is neither runs nor repos', async () => {
    const program = buildProgram(stubs);
    await expect(
      program.parseAsync(['discovery', 'list', 'nonsense'], { from: 'user' }),
    ).rejects.toThrow();
  });

  it('parses reset flags, defaulting to keeping the run history', async () => {
    const calls: unknown[] = [];
    const program = buildProgram({ ...stubs, discoveryReset: async (o) => void calls.push(o) });
    await program.parseAsync(['discovery', 'reset', '--query', 'istio'], { from: 'user' });
    expect(calls[0]).toEqual({ query: 'istio', all: false, includeRuns: false, yes: false });
  });

  it('parses reset --all --include-runs --yes', async () => {
    const calls: unknown[] = [];
    const program = buildProgram({ ...stubs, discoveryReset: async (o) => void calls.push(o) });
    await program.parseAsync(['discovery', 'reset', '--all', '--include-runs', '--yes'], {
      from: 'user',
    });
    expect(calls[0]).toEqual({ query: null, all: true, includeRuns: true, yes: true });
  });
});
```

Add the three stubs to whatever `stubs` object the file already defines:

```ts
  discoveryCount: async () => {},
  discoveryList: async () => {},
  discoveryReset: async () => {},
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/workers/src/cli/program.test.ts`
Expected: FAIL — `unknown command 'count'`.

- [ ] **Step 3: Extend `program.ts`**

Add to the `Handlers` type:

```ts
export type DiscoveryCountOptions = { query: string | null; json: boolean };
export type DiscoveryListOptions = {
  target: 'runs' | 'repos';
  query: string | null;
  limit: number;
  sort: string | null;
  json: boolean;
};
export type DiscoveryResetOptions = {
  query: string | null;
  all: boolean;
  includeRuns: boolean;
  yes: boolean;
};

export type Handlers = {
  discoverySweep: (options: DiscoveryOptions) => Promise<void>;
  discoveryCount: (options: DiscoveryCountOptions) => Promise<void>;
  discoveryList: (options: DiscoveryListOptions) => Promise<void>;
  discoveryReset: (options: DiscoveryResetOptions) => Promise<void>;
  // …the rest unchanged
};
```

Add the three commands after the existing `discovery.command('sweep')` block:

```ts
  discovery
    .command('count')
    .description('how much discovery data exists, per query')
    .addHelpText(
      'after',
      '\nEvery collection at once — a partial answer is not what anyone opens this for.\n' +
        'PENDING WINDOWS is what says whether a sweep finished or is mid-resume.',
    )
    .option('-q, --query <keyword>', 'narrow to one query')
    .option('--json', 'emit NDJSON to stdout instead of a table', false)
    .action(async ({ query, json }: { query?: string; json: boolean }) => {
      await handlers.discoveryCount({ query: orNull(query), json });
    });

  discovery
    .command('list')
    .description('list discovery runs (default) or discovered repos')
    .addHelpText(
      'after',
      '\nDefaults to `runs`: the sweep history is what this exists to expose — new repos found,\n' +
        'how long it took, how many GitHub Search calls it cost.\n' +
        '--sort accepts any field the collection declares sortable; anything else is rejected by name.',
    )
    .argument('[target]', 'runs or repos', 'runs')
    .option('-q, --query <keyword>', 'narrow to one query')
    .option('-l, --limit <n>', 'rows to show', positiveInteger, 20)
    .option('-s, --sort <field[:asc|desc]>', 'override the default ordering')
    .option('--json', 'emit NDJSON to stdout instead of a table', false)
    .action(
      async (
        target: string,
        { query, limit, sort, json }: { query?: string; limit: number; sort?: string; json: boolean },
      ) => {
        if (target !== 'runs' && target !== 'repos') {
          throw new Error(`list target must be runs or repos, got "${target}"`);
        }
        await handlers.discoveryList({
          target,
          query: orNull(query),
          limit,
          sort: orNull(sort),
          json,
        });
      },
    );

  discovery
    .command('reset')
    .description("delete a query's corpus and resume state, keeping its run history")
    .addHelpText(
      'after',
      '\nThis data is NOT rebuildable offline: the next sweep re-queries GitHub Search.\n' +
        'The run history is kept by default — it is the one collection nothing can\n' +
        'reconstruct, and a reset is when you most want to read it. --include-runs deletes it.\n' +
        'There is no default target: pass --query or --all.',
    )
    .option('-q, --query <keyword>', 'the query to reset')
    .option('--all', 'reset every query', false)
    .option('--include-runs', 'delete the run history too', false)
    .option('-y, --yes', 'skip the confirmation prompt', false)
    .action(
      async ({
        query,
        all,
        includeRuns,
        yes,
      }: {
        query?: string;
        all: boolean;
        includeRuns: boolean;
        yes: boolean;
      }) => {
        await handlers.discoveryReset({ query: orNull(query), all, includeRuns, yes });
      },
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/workers/src/cli/program.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the handlers**

In `apps/workers/src/cli/handlers.ts`, add at the top of the file (a static import is fine —
`node:readline` is a core module and costs nothing):

```ts
import { createInterface } from 'node:readline/promises';
```

and the three handlers:

```ts
  discoveryCount: async ({ query, json }) => {
    const { createDataStore } = await import('./data-store');
    const { countDiscovery } = await import('../discovery/explore');
    const { formatCount, ndjson } = await import('../discovery/explore-format');

    const rows = await countDiscovery(createDataStore(), { query });
    // stdout, not the logger: this is a result, not a log line (§8 of the spec).
    process.stdout.write(`${json ? ndjson(rows) : formatCount(rows)}\n`);
  },

  discoveryList: async ({ target, query, limit, sort, json }) => {
    const { createDataStore } = await import('./data-store');
    const { listRepos, listRuns } = await import('../discovery/explore');
    const { formatRepos, formatRuns, ndjson } = await import('../discovery/explore-format');

    const dataStore = createDataStore();
    const options = { query, limit, sort };
    const result = target === 'runs' ? await listRuns(dataStore, options) : await listRepos(dataStore, options);

    const rendered = json
      ? ndjson(result.rows)
      : target === 'runs'
        ? formatRuns(result)
        : formatRepos(result);
    process.stdout.write(`${rendered}\n`);
  },

  discoveryReset: async ({ query, all, includeRuns, yes }) => {
    const { createDataStore } = await import('./data-store');
    const { applyReset, planReset } = await import('../discovery/explore');

    const dataStore = createDataStore();
    const plans = await planReset(dataStore, { query, all, includeRuns });

    if (plans.length === 0) {
      log.info({ query, all }, 'nothing to reset');
      return;
    }

    // The plan prints before the prompt, with real counts: an operator confirms against what
    // is actually there, not against what they assumed was there.
    for (const plan of plans) {
      process.stdout.write(
        `  ${plan.query_slug}\n` +
          `    discovery_repos  ${plan.repos.toLocaleString('en-US').padStart(8)}  → delete\n` +
          `    discovery_state  ${String(plan.state).padStart(8)}  → delete\n` +
          `    discovery_runs   ${plan.runs.toLocaleString('en-US').padStart(8)}  → ` +
          `${plan.delete_runs ? 'delete' : 'keep (--include-runs to delete)'}\n`,
      );
    }
    process.stdout.write(
      '\nthis is not rebuildable offline; the next sweep re-queries GitHub Search\n',
    );

    if (!yes && !(await confirm())) {
      log.warn({ query, all }, 'reset cancelled');
      return;
    }

    await applyReset(dataStore, plans);
    log.info(
      { queries: plans.map((plan) => plan.query_slug), include_runs: includeRuns },
      'discovery reset',
    );
  },
```

and the prompt helper at the bottom of the file:

```ts
/**
 * Defaults to no on anything that is not an explicit `y`, including EOF — a reset piped from
 * a script with no `--yes` must decline rather than proceed on an empty stdin.
 */
async function confirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question('continue? [y/N] ')).trim().toLowerCase() === 'y';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 6: Verify end to end**

```bash
mise run kecoctl -- discovery count
mise run kecoctl -- discovery list runs --limit 5
mise run kecoctl -- discovery list repos --query kubernetes --limit 5
mise run kecoctl -- discovery reset --query kubernetes    # answer n
mise run kecoctl -- discovery reset                        # expect the no-target refusal
```

Expected: the tables from spec §8; the bare `reset` exits non-zero naming `--query` and
`--all`; answering `n` leaves every count unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/workers/src/cli/program.ts apps/workers/src/cli/program.test.ts apps/workers/src/cli/handlers.ts
git commit -m "feat(cli): add discovery count, list and reset

reset prints its plan with real counts before prompting, and the prompt
defaults to no on anything that is not an explicit y — including EOF, so
a scripted reset with no --yes declines rather than proceeding on empty
stdin."
```

---

## Phase 5 — Tooling and docs

### Task 17: Tighten the import boundaries

**Files:**
- Modify: `eslint.config.mjs`

The migration makes discovery's existing ban *sufficient* — it never imports `@keco/search`,
so no exemption is needed. Two tightenings close the gaps the new files open.

- [ ] **Step 1: Add `lib/**` to the write-side ban**

Replace the `files` array of the "Only the projector writes to Meilisearch" block:

```js
  // Only the projector writes searchable read models. Everything else on the write side that
  // needs storage goes through the DataStore port (apps/workers/src/lib/data-store.ts), whose
  // sole backend implementation lives in cli/data-store.ts — see
  // docs/adr/0002-discovery-datastore.md.
  //
  // src/lib is in this list because the port itself is there: the day it imports @keco/search
  // is the day every worker can see a search engine again, which is the one thing the port
  // exists to prevent.
  {
    files: [
      'apps/workers/src/discovery/**/*.ts',
      'apps/workers/src/crawler/**/*.ts',
      'apps/workers/src/analyzer/**/*.ts',
      'apps/workers/src/lib/**/*.ts',
    ],
    rules: boundary(
      'Only the projector may import @keco/search. Workers take a DataStore; only ' +
        'apps/workers/src/cli/data-store.ts knows what implements it (§7).',
      // `meilisearch` as well as `@keco/search`: the client is a direct devDependency of
      // apps/workers since Task 5, so banning only the wrapper would leave a worker free to
      // import the raw client and bypass the port entirely.
      [['@keco/search', 'meilisearch']],
    ),
  },
```

- [ ] **Step 2: Narrow the CLI rule from two files to the whole directory**

```js
  // The CLI layer composes runners; it does not do work. It sits outside every glob above, so
  // without this rule it is the one place in apps/workers with no boundary at all.
  //
  // Two deliberate exceptions, both in `ignores`: handlers.ts holds the admin client for the
  // `index` commands the way engine/cli.ts did, and data-store.ts is the composition root's
  // one backend implementation. Listing the directory rather than two filenames means a new
  // cli/*.ts is bounded by default instead of silently unbounded.
  {
    files: ['apps/workers/src/cli/**/*.ts', 'apps/workers/src/cli.ts'],
    ignores: ['apps/workers/src/cli/handlers.ts', 'apps/workers/src/cli/data-store.ts'],
    rules: boundary(
      "apps/workers/src/cli wiring may import worker runners and commander — never a worker's own dependencies (§7).",
      [['@keco/search', 'meilisearch', '@keco/github', '@keco/signals', '@keco/analyze']],
    ),
  },
```

- [ ] **Step 3: Verify the boundary actually bites**

Temporarily add `import '@keco/search';` to the top of
`apps/workers/src/discovery/store/store.ts` and to `apps/workers/src/lib/data-store.ts`.

Run: `pnpm lint`
Expected: FAIL, once for each file, naming the rule.

Remove both lines and re-run.

Run: `pnpm lint`
Expected: PASS.

A boundary rule that is never seen to fail is a rule nobody knows is wired up.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(lint): bound the DataStore port away from @keco/search

The migration makes discovery's existing ban sufficient rather than
needing an exemption — it never imports @keco/search at all. Two gaps
closed: src/lib joins the ban so the port cannot grow a backend import,
and the CLI rule covers the directory with two named exceptions rather
than naming two files, so a new cli/*.ts is bounded by default."
```

---

### Task 18: mise tasks, index provisioning, and the guarded `infra:reset`

**Files:**
- Modify: `mise.toml`
- Modify: `apps/workers/src/cli/handlers.ts` (`indexCreate` provisions the discovery collections)
- Create: `infra/reset.sh`

- [ ] **Step 1: Provision the discovery collections from `index create`**

A deployment bootstrap should cover both usages in one step. In `handlers.ts`, extend
`indexCreate` after the existing `createIndex` call:

```ts
    // The discovery collections are provisioned here too, so a fresh deployment bootstraps
    // both usages of the instance — the searchable read model and the write-side data store.
    // ensure() compares settings before applying them, so this is safe to re-run.
    const { createDataStore } = await import('./data-store');
    const { DISCOVERY_COLLECTIONS } = await import('../discovery/store/collections');
    await createDataStore({ ...process.env, MEILI_HOST: host }).ensure(DISCOVERY_COLLECTIONS);
    log.info(
      { collections: DISCOVERY_COLLECTIONS.map((c) => c.name) },
      'discovery collections ready',
    );
```

Note `createDataStore` takes an env override — confirm its signature from Task 5 matches
`createDataStore(env: NodeJS.ProcessEnv = process.env)`.

- [ ] **Step 2: Add the three mise tasks**

In `mise.toml`, after `[tasks."discovery:sweep"]`:

```toml
[tasks."discovery:count"]
description = "How much discovery data exists, per query: repos, runs, pending windows, last sweep. Args: --query kubernetes --json"
run = "pnpm -F @keco/workers kecoctl discovery count"

[tasks."discovery:list"]
description = "List discovery runs (default) or discovered repos. Args: runs|repos --query kubernetes --limit 20 --sort duration_ms --json"
run = "pnpm -F @keco/workers kecoctl discovery list"

[tasks."discovery:reset"]
description = "Delete a query's corpus and resume state, keeping its run history. NOT rebuildable offline. Args: --query kubernetes | --all --include-runs --yes"
run = "pnpm -F @keco/workers kecoctl discovery reset"
```

- [ ] **Step 3: Write the `infra:reset` preflight**

```bash
# infra/reset.sh
#!/usr/bin/env bash
# `mise run infra:reset` used to mean "wipe the read model; rebuild offline in minutes with
# zero GitHub calls". That is no longer the whole truth: the same Meilisearch volume now holds
# discovery's write model, which is NOT rebuildable offline — only by re-sweeping GitHub
# Search, which is hours of paced requests.
#
# So the command says what it is about to destroy before destroying it. The counts come from
# `kecoctl discovery count`, not from a second query written here, so the two can never
# disagree about what is on disk.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--yes" ]]; then
  echo "this destroys discovery write-model data that is NOT rebuildable offline:"
  echo
  # A dead or empty Meilisearch is not a reason to refuse to reset it — that is very often
  # exactly why someone is resetting.
  pnpm -s -F @keco/workers kecoctl discovery count 2>/dev/null || echo "  (could not read discovery data)"
  echo
  read -r -p "continue? [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "cancelled"; exit 1; }
fi

docker compose -f infra/compose.yml down -v
```

```bash
chmod +x infra/reset.sh
```

Replace the `infra:reset` task:

```toml
[tasks."infra:reset"]
description = "Stop Meilisearch and delete its volume. Destroys the read model (rebuildable offline) AND discovery's write model (NOT rebuildable — a re-sweep, not a replay). Prompts unless --yes"
run = "./infra/reset.sh"
```

- [ ] **Step 4: Verify**

```bash
mise run index:create
mise run discovery:count
mise run infra:reset          # answer n
mise run infra:reset --yes    # non-interactive
```

Expected: `index:create` reports the three discovery collections; `discovery:count` runs;
`infra:reset` prints the counts and exits 1 on `n`; `--yes` tears down without prompting.

- [ ] **Step 5: Commit**

```bash
git add mise.toml infra/reset.sh apps/workers/src/cli/handlers.ts
git commit -m "chore(infra): guard infra:reset and provision discovery collections

infra:reset no longer only wipes a disposable read model — the same
volume now holds discovery's write model, which comes back only by
re-sweeping GitHub. The preflight prints what it will destroy using
kecoctl discovery count, so the warning and the data cannot disagree.

index create now provisions the discovery collections too, so a fresh
deployment bootstraps both usages of the instance in one step."
```

---

### Task 19: The ADR and AGENTS.md

**Files:**
- Create: `docs/adr/0002-discovery-datastore.md`
- Modify: `AGENTS.md` (§3, §4, §4.1, §5, §7, §8, §14)
- Modify: `docs/superpowers/specs/2026-08-29-discovery-datastore-design.md` (§7's durability mechanism)

- [ ] **Step 1: Write the ADR**

```markdown
# ADR 0002 — Discovery's write model moves to a `DataStore` port

**Date:** 2026-08-29
**Status:** accepted
**Supersedes:** the storage half of `docs/superpowers/specs/2026-08-02-discovery-worker-design.md`
**Related:** ADR 0001 (CQRS, no database)

## Context

Discovery wrote four artifacts to the filesystem cache: a full list, one detail YAML per repo,
a hash index and a resume state file. Three problems followed. There was no history — a
sweep's summary was logged once and lost, so nothing could answer "how did last night's sweep
go" or "how many GitHub Search calls did that cost". The corpus was not queryable: 100k YAML
files in two-letter buckets, readable by key and nothing else. And the substrate was hardcoded
— `DiscoveryStore` reached `@keco/cache` directly, so it was not a decision anyone could
revisit.

## Decision

Discovery's data moves behind a **`DataStore` port** (`apps/workers/src/lib/data-store.ts`):
documents, equality filters, sort, count. Three implementations satisfy one conformance suite
— in-memory, filesystem, and Meilisearch — and **only `apps/workers/src/cli/data-store.ts`
knows which one is in use.** Workers take the interface; the CLI composition root injects an
implementation.

Discovery's data becomes three collections: `discovery_repos` (the corpus, replacing the detail
YAMLs, the full list and the hash index at once, since `payload_hash` is now a field),
`discovery_runs` (one document per sweep process), and `discovery_state` (resume).

## Why this does not violate ADR 0001 or AGENTS.md §2

AGENTS.md §4 says "the projector is the only writer to Meilisearch" and §2.1 says "the write
side never reads a read model". **Both are about searchable read models** — `tools`, the public
corpus the portal and API query — not about the Meilisearch *process*. §5 already draws the
other half of the line: "`searchableAttributes: []` makes an index a plain key-value store …
use it for everything that isn't the search corpus."

So there are two usages of one deployed instance:

| Usage | Collections | Owner | Rebuildable offline |
|---|---|---|---|
| Searchable read model | `tools`, `repos_state`, `traces` | projector | yes, from cache, zero network |
| Key-value data store | `discovery_*` | discovery | **no** — only by re-sweeping GitHub |

§4's rule is restated as **only the projector writes searchable read models**, which remains
true. Discovery writes write-model data through a storage port, the way it already writes
`repos/**` through `Storage`. ADR 0001's "no database" holds: there is still no relational
store, no schema migration and no join.

## Consequences

**`mise run infra:reset` stops being free.** It used to wipe a disposable read model
rebuildable offline in minutes. It now also destroys discovery's resume state and corpus,
which come back only by re-sweeping GitHub Search — hours of paced requests. The task grows a
preflight that prints what it will destroy and requires confirmation. This is the real cost of
this decision and it was accepted knowingly.

**`.cache/discovery/` is orphaned.** Nothing reads or writes it after this change. It is
rebuildable and the cache is disposable, so it is left in place rather than migrated; delete it
with `rm -rf .cache/discovery`. There is deliberately no runtime warning about it, because
`runDiscovery` no longer holds a `Cache` handle to probe with — adding one back to print a
message would reintroduce exactly the coupling this ADR removes.

**Two accidental improvements.** `--fresh` now deletes rather than merely ignoring, which
retires the orphaned-detail-file limitation the old store documented. And the corpus is one
map keyed by repo id instead of an id-keyed list plus a name-keyed hash index, so the desync
after a repo rename has no second key to drift from.

## Alternatives rejected

**Keep the filesystem and add a separate run log.** Answers the history question and nothing
else; leaves the corpus unqueryable and the substrate hardcoded.

**A discovery-specific port rather than a general one.** Would have let Meilisearch concepts —
tasks, index settings, filter strings — leak into the interface, since a narrower port tends to
be shaped by its one implementation. The generic port has no backend vocabulary in it at all,
which is what makes the lint rule checkable.

**Migrate the projector too.** Its job is *defined* as writing the searchable read model, and
it needs alias swaps, count-verified promotion and rebuild-index creation — none of which
`DataStore` models. Modelling them would drag those concepts into the port. Out of scope.
```

- [ ] **Step 2: Update AGENTS.md**

- **§3** — remove the `discovery/` subtree from the cache layout diagram. Add beneath it: "Discovery no longer writes to the cache; its data lives behind the `DataStore` port (§4.1)."
- **§4** — in the worker table, change discovery's *Produces* column from `discovery/{query}/**` to `discovery_repos`, `discovery_runs`, `discovery_state` (via `DataStore`). Add to the consequences list: "Workers depend on the `DataStore` port, never on a backend. Only `apps/workers/src/cli/data-store.ts` knows what implements it — see ADR 0002."
- **§4.1** — replace the paragraph naming `store.ts` and the YAML artifacts. Note that `--fresh` now deletes, and that every sweep writes a `discovery_runs` document (`running` at open, terminal at exit; a `SIGKILL` leaves it `running` on purpose).
- **§5** — add the two-usages table from the ADR above the existing index table, and add the three `discovery_*` collections to that table marked *write model, not a read model*.
- **§7** — in the layout tree, replace `discovery/` with the `store/` subdirectory and `explore*.ts`; add `lib/data-store*.ts` and `cli/data-store.ts`. In the import-boundaries list, replace "only the projector may import `@keco/search`" with: "only the projector may import `@keco/search`; every other worker takes a `DataStore`, and only `apps/workers/src/cli/data-store.ts` implements it."
- **§8** — add `discovery:count`, `discovery:list` and `discovery:reset` to the command table. Update the `infra:reset` row to say it now also destroys discovery's write model and prompts. Update the "Wiping the write model is `rm -rf .cache`" sentence: that no longer covers discovery, which is `kecoctl discovery reset`.
- **§14** — under "Frontend and API"'s sibling sections, add to the pipeline list: "**A `DataStore` implementation that serialises after an `await`** persists a half-mutated array. `runDiscovery` aliases `state.pending_windows` as its live work queue and keeps mutating it during a flush, so every implementation must deep-copy synchronously before its first await. The conformance suite pins it."

- [ ] **Step 3: Amend the spec's durability mechanism**

In `docs/superpowers/specs/2026-08-29-discovery-datastore-design.md` §7, replace the sentence
describing the durability check with:

```markdown
`durable: true` means "this write and every earlier write through this handle". The
Meilisearch implementation keeps the task uids it has enqueued and waits on the whole set with
`client.tasks.waitForTasks(uids)` — one call, and it assumes nothing about the order the
backend processes tasks in. (An earlier draft awaited only the newest task and then verified
the rest, which quietly rested the corpus-before-state guarantee on Meilisearch's scheduler
being FIFO. It is, today. That is not a thing to depend on for free when not depending on it
is also free.)
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0002-discovery-datastore.md AGENTS.md \
        docs/superpowers/specs/2026-08-29-discovery-datastore-design.md
git commit -m "docs: record the DataStore decision and update the contract

ADR 0002 states the distinction the whole design rests on: §4's 'only
writer to Meilisearch' governs searchable read models, not the process.
Discovery's collections are write-model data sharing the instance.

Names the real cost too: infra:reset stops being free, because the
volume now holds something no replay can rebuild."
```

---

### Task 20: Full verification

**Files:** none — this task only runs things and fixes what it finds.

- [ ] **Step 1: The gate**

Run: `mise run ci`
Expected: PASS — check, lint, test, taxonomy:check.

- [ ] **Step 2: The integration suite**

```bash
mise run infra:up
MEILI_INTEGRATION=1 pnpm vitest run apps/workers/src/cli/data-store.integration.test.ts
```
Expected: PASS.

- [ ] **Step 3: Confirm no stale references survive**

```bash
grep -rn "discoveryKeys\|legacyDiscoveryStateKey\|repos-full-list\|_hashes.json" \
  apps packages --include="*.ts"
```
Expected: no matches. Any hit is a caller this plan missed.

```bash
grep -rln "@keco/search" apps/workers/src
```
Expected: exactly three files — `projector/index.ts`, `cli/handlers.ts`, `cli/data-store.ts`.
Anything else means the port has been bypassed.

- [ ] **Step 4: Prove the migration end to end against a clean backend**

```bash
mise run infra:reset --yes
mise run infra:up
mise run index:create
GITHUB_TOKEN=$GITHUB_TOKEN mise run discovery:sweep -- --query kubernetes --limit 200 --fresh
GITHUB_TOKEN=$GITHUB_TOKEN mise run discovery:sweep -- --query kubernetes --limit 200
mise run discovery:count
mise run discovery:list -- runs
```

Expected: two run documents. The first has a non-zero `repos_new`; the second reports
`repos_new` 0 and a non-zero `repos_unchanged` — the original discovery design's definition of
done ("re-running writes zero documents and reports every repo as unchanged"), now readable
from the history instead of by stat-ing a cache.

- [ ] **Step 5: Prove the fs implementation is a real path, not decoration**

```bash
DISCOVERY_STORE=fs GITHUB_TOKEN=$GITHUB_TOKEN \
  mise run discovery:sweep -- --query istio --limit 50 --fresh
DISCOVERY_STORE=fs mise run discovery:count
DISCOVERY_STORE=fs mise run discovery:list -- runs
ls .cache/data/discovery_runs/
```

Expected: the sweep completes with Meilisearch untouched, `count` and `list` render the same
tables, and one JSON file per run sits on disk.

- [ ] **Step 6: Commit anything the verification changed**

```bash
git add -A && git commit -m "fix(discovery): address issues found in full verification"
```

(Skip if nothing changed.)

---

## Notes for the implementer

**Read the spec first.** `docs/superpowers/specs/2026-08-29-discovery-datastore-design.md` §2
explains why writing discovery data to Meilisearch is not a CQRS violation. If that
distinction is not clear, the lint rules in Task 17 will look arbitrary and someone will
relax them.

**Three things in this plan exist because a specific bug is possible:**

1. **Deep-copy on `put`.** `runDiscovery` aliases `state.pending_windows` as its live work
   queue and mutates it while a flush is in flight. The filesystem store got away with it only
   because `JSON.stringify` is synchronous. Any implementation that serialises after an
   `await` silently loses windows.
2. **`durable` means "and everything before it."** The corpus is written without waiting and
   state with waiting. If state can become durable first, a crash leaves it claiming windows
   whose repos were never written — a truncated corpus with nothing to signal it.
3. **`ensure()` compares before applying.** Applying settings to a populated Meilisearch index
   reindexes it. Without the comparison, every sweep reindexes 31k documents for no change.

**What "done" looks like beyond green tests:** `mise run discovery:list runs` shows a row per
sweep with new repos, duration and GitHub Search calls; `grep -rln "@keco/search"
apps/workers/src` returns three files; and `mise run infra:reset` tells you what it is about to
destroy before it does it.
