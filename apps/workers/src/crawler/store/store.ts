import type { DataStore } from '../../lib/data-store';
import {
  CRAWL_COLLECTIONS,
  CRAWL_HISTORY,
  emptyCounters,
  toCrawlRunDocument,
  type CrawlCounters,
  type CrawlOutcome,
  type SeedError,
} from './collections';

/**
 * The crawl run history, over the `DataStore` port — no filesystem, no backend, no key
 * building. `collections.ts` owns the document shape; this file owns the bookkeeping.
 *
 * The contract is `DiscoveryStore`'s, for the reasons discovery learned it (AGENTS.md §4.1):
 *  - `open()` writes the document immediately with `outcome: 'running'`.
 *  - `finishRun()` stamps the ending on EVERY path out — complete, failed, and the shutdown
 *    handler's `interrupted`.
 *  - A `SIGKILL` therefore leaves a run stuck at `running` forever, deliberately. That row is
 *    how an operator spots a crawl that died without cleanup; a later run quietly repairing it
 *    would hide exactly the failure someone is looking for.
 */
export type OpenOptions = {
  /** Injected so tests are deterministic. */
  runId: string;
  startedAt: Date;
  seeds: readonly string[];
  limit: number | null;
  repo: string | null;
  shardCount: number;
  shardIndex: number;
};

export class CrawlHistoryStore {
  /**
   * Mutated in place by the loop and read at every write. Plain numbers on a single-threaded
   * event loop, so the p-queue workers cannot interleave a read-modify-write.
   */
  readonly counters: CrawlCounters = emptyCounters();

  private readonly seedErrors: SeedError[] = [];

  /**
   * The first ending wins. The shutdown handler and the loop's own `finally` can both fire —
   * a run that was interrupted did not later complete, and reporting that it did would erase
   * the only evidence the operator has.
   */
  private finished = false;

  private constructor(
    private readonly dataStore: DataStore,
    private readonly options: OpenOptions,
  ) {}

  static async open(dataStore: DataStore, options: OpenOptions): Promise<CrawlHistoryStore> {
    // Every implementation refuses an unknown collection by design, and a crawl on a fresh
    // machine has nothing in front of it to provision one.
    await dataStore.ensure(CRAWL_COLLECTIONS);
    const store = new CrawlHistoryStore(dataStore, options);
    await store.write('running');
    return store;
  }

  recordSeedError(name: string, error: string): void {
    this.seedErrors.push({ name, error });
  }

  async finishRun(outcome: Exclude<CrawlOutcome, 'running'>, now = new Date()): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.write(outcome, now);
  }

  private async write(outcome: CrawlOutcome, endedAt?: Date): Promise<void> {
    await this.dataStore.put(
      CRAWL_HISTORY,
      [
        toCrawlRunDocument({
          ...this.options,
          outcome,
          ...(outcome === 'running' ? {} : { endedAt: endedAt ?? new Date() }),
          counters: { ...this.counters },
          seedErrors: [...this.seedErrors],
        }),
      ],
      // The run record is the thing an operator reads after a crash. Losing it to a buffered
      // write is the one outcome this collection exists to prevent.
      { durable: true },
    );
  }
}
