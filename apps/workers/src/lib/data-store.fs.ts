// apps/workers/src/lib/data-store.fs.ts
import type { Storage } from '@keco/cache';
import {
  assertDocumentId,
  assertNonEmptyWhere,
  compareBySort,
  matchesWhere,
  projectFields,
  DOCUMENT_ID_PATTERN,
  MAX_DOCUMENT_ID_LENGTH,
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
    // Unused: every `FsStorage.put` call below already only resolves once its rename has
    // landed on disk, so a sequentially-awaited put is durable regardless of this flag. The
    // parameter still has to exist — declared with the interface's own type — so the class's
    // own signature matches `DataStore.put` for callers that hold a concrete `FsDataStore`
    // rather than the interface, exactly as the layout test above does.
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
    // collection must throw here exactly as it does in the other two implementations.
    this.primaryKeyOf(collection);

    // `id` arrives from a caller, not from `put`, so it has never been validated. Interpolated
    // straight into a key it is a path-traversal hole: `../../secret` reads outside the data
    // tree entirely. Answer `null` rather than throwing — an id `put` would refuse cannot name
    // a stored document, so "no such document" is both true and what the in-memory store says.
    if (id.length > MAX_DOCUMENT_ID_LENGTH || !DOCUMENT_ID_PATTERN.test(id)) return null;

    const buffer = await this.storage.get(documentKey(collection, id));
    if (buffer === null) return null;
    try {
      return JSON.parse(buffer.toString('utf8')) as Document;
    } catch {
      // §13: one bad record never aborts a run, and `list`/`count` already skip this file.
      // Throwing here would make the same corrupt file fatal on one path and tolerated on
      // another.
      return null;
    }
  }

  async count(collection: string, where?: Where): Promise<number> {
    let total = 0;
    for await (const [, document] of this.readAll(collection)) {
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
      for await (const [, document] of this.readAll(collection)) {
        if (!matchesWhere(document, query.where)) continue;
        yield projectFields(document, query.fields);
        yielded += 1;
        if (query.limit !== undefined && yielded >= query.limit) return;
      }
      return;
    }

    const rows: Document[] = [];
    for await (const [, document] of this.readAll(collection)) {
      if (matchesWhere(document, query.where)) rows.push(document);
    }
    rows.sort(compareBySort(query.sort));
    const limited = query.limit === undefined ? rows : rows.slice(0, query.limit);
    for (const row of limited) yield projectFields(row, query.fields);
  }

  async remove(collection: string, where: Where): Promise<void> {
    assertNonEmptyWhere(where, collection);
    // Delete the key each document was actually read from, never a key rebuilt from its
    // primary-key field. A hand-edited or foreign-written file whose `id` field disagrees
    // with its filename — or worse, holds `../../elsewhere` — would otherwise make `remove`
    // delete the wrong file, or a file outside the data tree entirely, while leaving the
    // matched document in place. `readAll` already calls `primaryKeyOf`, so this doesn't
    // need to.
    const doomed: string[] = [];
    for await (const [key, document] of this.readAll(collection)) {
      if (matchesWhere(document, where)) doomed.push(key);
    }
    for (const key of doomed) await this.storage.delete(key);
  }

  /**
   * Yields each document alongside the exact key it was read from — `remove` deletes that
   * key, never one rebuilt from the document's primary-key field, which is what keeps a
   * mismatched or hostile `id` value from ever choosing which file gets deleted.
   *
   * A document that fails to parse is skipped, not thrown: AGENTS.md §13 — one bad record
   * must never abort a run, and this store's whole audience is a developer who may well have
   * hand-edited a file.
   */
  private async *readAll(collection: string): AsyncIterable<readonly [string, Document]> {
    this.primaryKeyOf(collection); // fail fast on an unknown collection
    for (const key of await this.storage.list(collectionPrefix(collection))) {
      const buffer = await this.storage.get(key);
      if (buffer === null) continue;
      try {
        yield [key, JSON.parse(buffer.toString('utf8')) as Document];
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
