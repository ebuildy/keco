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

/**
 * Deliberately its own shape rather than `Required<Pick<Settings, ...>>`: Meilisearch's own
 * `Settings` types each of these as `T[] | null` (and `filterableAttributes` additionally
 * admits `GranularFilterableAttribute` objects), because a *real* index can carry those. This
 * port only ever writes plain string lists — `settingsFor` builds nothing else — so the
 * managed shape says exactly that, and `settingsMatch` treats anything else `getSettings()`
 * might report as "does not match," which is the correct, safe direction.
 */
export type ManagedSettings = {
  filterableAttributes: string[];
  sortableAttributes: string[];
  searchableAttributes: string[];
};

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

// `a` is `unknown`, not `readonly string[] | null`, because the live shapes
// (`FilterableAttributes` etc.) additionally admit `GranularFilterableAttribute` objects and
// don't type-assert cleanly onto a plain string array. Comparing by stringified elements is
// exactly as strict for the case this port ever writes (plain strings), and safely reports
// "different" for anything richer that a hand-applied setting might have introduced.
const sameSet = (a: unknown, b: readonly string[]): boolean =>
  Array.isArray(a) &&
  a.length === b.length &&
  [...a].map(String).sort().join() === [...b].sort().join();

/**
 * Whether an index already has the settings we want. `ensure` runs at the start of every
 * sweep, and applying settings to a populated index *reindexes it* — 31k documents, every
 * run, for no change. Comparing first is what makes `ensure` genuinely idempotent rather
 * than merely repeatable.
 */
export function settingsMatch(current: Settings, desired: ManagedSettings): boolean {
  return (
    sameSet(current.filterableAttributes, desired.filterableAttributes) &&
    sameSet(current.sortableAttributes, desired.sortableAttributes) &&
    sameSet(current.searchableAttributes, desired.searchableAttributes)
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
      const enqueued = await this.client.index<Document>(collection).updateDocuments(copies);
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
      return await this.client.index<Document>(collection).getDocument(id);
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
      .index<Document>(collection)
      .getDocuments<Document>({ limit: 0, filter: toFilter(where) });
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

      const page = await this.client.index<Document>(collection).getDocuments<Document>({
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
    // synchronously — a missing index turns into a *failed* task, not a rejected promise, so
    // waiting on it without checking its status would let a typo'd collection name resolve as
    // a silent no-op. This check gives remove() the same fail-fast behaviour every other
    // method already has (§ "an unknown collection must throw from every operation").
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
