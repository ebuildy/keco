/**
 * The persistence port for the write side's *non-cache* data (AGENTS.md §4).
 *
 * This file must never import a backend. Workers depend on this interface; exactly one file
 * in the repo — `apps/workers/src/cli/data-store.ts` — knows what implements it. Task 17 of
 * this plan adds an `eslint.config.mjs` rule that enforces that; until then it is a convention,
 * not yet a guarantee. The whole point of the port is that a worker cannot tell whether it is
 * talking to Meilisearch, the filesystem or a Map.
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

  /** Pages internally; the caller never sees an offset. */
  list(collection: string, query?: ListQuery): AsyncIterable<Document>;

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
 * it is absent, and burying it is what an operator reading a table expects. `null` and
 * `undefined` are one equivalence class here — different implementations store an absent
 * field differently (an omitted key vs. an explicit `null`), and they must sort identically
 * or the result depends on which backend wrote the document.
 *
 * Known remaining hole, deliberately unfixed: a field holding two different types across
 * documents (`5` vs `'abc'`) has the same non-antisymmetry problem, because both `<`
 * comparisons come back false. A sortable field holding mixed types is a data bug in the
 * caller, not something this port should paper over with an invented type-ordering rule.
 * `NaN` is the same hole and is additionally non-reflexive — `NaN !== NaN` skips the
 * equality check, and `NaN < 5` and `5 < NaN` are both false — but `Document` is declared
 * JSON-serialisable and JSON has no `NaN`, so only the in-memory store's `structuredClone`
 * can ever produce one; the filesystem and Meilisearch stores cannot.
 */
export function compareBySort(sort: Sort): (a: Document, b: Document) => number {
  return (a, b) => {
    for (const [field, direction] of sort) {
      const left = a[field];
      const right = b[field];
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
 * The charset alone does not make an id a safe filename — a long one still is not. The
 * filesystem store keys a document by its id, and most filesystems cap a single path segment
 * at 255 bytes (`NAME_MAX`); without this bound a long `--query` slug produces an id the
 * memory store and Meilisearch both accept and the filesystem store rejects with
 * `ENAMETOOLONG`, a per-implementation divergence the conformance suite would surface as a
 * mysterious, backend-specific failure. This bound is what makes all three agree.
 *
 * 250, not 255: the filesystem store keys a document as `data/{collection}/{id}.json`, so
 * the final path segment is the id plus the 5-byte `.json` suffix. Budgeting the full
 * `NAME_MAX` for the id alone leaves no room for that suffix and still fails with
 * `ENAMETOOLONG` at exactly the boundary this constant exists to guard.
 */
export const MAX_DOCUMENT_ID_LENGTH = 250;

export function assertDocumentId(
  id: unknown,
  collection: string,
  primaryKey: string,
): asserts id is string {
  // `typeof id !== 'string'` catches a genuinely missing id — including a raw `undefined`,
  // which `DOCUMENT_ID_PATTERN.test(undefined)` would otherwise accept by coercing it to the
  // string `"undefined"` and matching that against the charset below.
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
