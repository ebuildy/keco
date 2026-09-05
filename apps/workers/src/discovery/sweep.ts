import type { DiscoveryState } from './store/collections';
import { initialWindows } from './windows';

/**
 * Resume the interrupted sweep, or start a new one.
 *
 * A non-empty queue means the last sweep was interrupted, so continue it. An empty one means
 * the last sweep finished (or there was none): start over across every window.
 *
 * Which fields reset is the whole point, and it is the part that had a bug:
 *  - **window bookkeeping and the per-sweep counters reset.** They describe *this* sweep, so
 *    carrying `pages_fetched` forward from a finished sweep silently inflates the next one.
 *  - **the corpus does not.** `entries` and `hashes` live in `DiscoveryStore` and are
 *    untouched here — that is exactly what makes a second sweep re-check the corpus while
 *    still skipping every document whose payload has not changed.
 *
 * Mutates `state` in place because it *is* the persisted resume point; returns whether this
 * is a resume, for logging.
 */
export function beginSweep(state: DiscoveryState, query: string, now: Date): boolean {
  if (state.pending_windows.length > 0) return true;

  state.pending_windows = initialWindows(query);
  state.completed_windows = [];
  state.failed_windows = [];
  state.started_at = now.toISOString();
  state.pages_fetched = 0;
  state.dropped = 0;
  return false;
}
