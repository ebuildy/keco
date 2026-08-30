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
    // Synchronous copy before any await — the port's deep-copy contract. structuredClone is
    // the whole of it here: callers hand us live arrays they keep mutating.
    //
    // Validation happens in this pass, before anything is written, so a batch with one bad
    // document lands nothing. The filesystem and Meilisearch stores get that for free by
    // building their whole payload before issuing a write; doing it by accident here would
    // leave the reference double with partial-write behaviour neither real backend has.
    const primaryKey = this.primaryKeyOf(collection);
    const copies = documents.map((document) => {
      const copy = structuredClone(document) as Document;
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
    return found === undefined ? null : (structuredClone(found) as Document);
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
      yield projectFields(structuredClone(row) as Document, query.fields);
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
