import { Cache, createStorage, Journal } from '@keco/cache';
import { config } from './config';

/** Shared write-side wiring. Workers never call each other — only the cache and journal (§4). */
export function createRuntime() {
  const cache = new Cache(createStorage({ dir: config.CACHE_DIR }));
  return { cache, journal: new Journal(cache) };
}

/**
 * A single bad repo must never abort a run (§13). Catch per item, emit RepoFailed,
 * continue — the run's job is to make progress, not to be pure.
 */
export async function perItem<T>(
  item: string,
  work: () => Promise<T>,
  onError: (repo: string, error: Error) => Promise<void>,
): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    await onError(item, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}
