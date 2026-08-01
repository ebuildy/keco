import { Event, type Checkpoint, type NewEvent } from '@keco/core';
import { monotonicFactory } from 'ulid';
import { checkpointKey, dayOf, journalDayPrefix, journalKey } from './keys';
import type { Cache } from './storage';

/**
 * The append-only journal and its per-consumer checkpoints (AGENTS.md §3).
 *
 * ULIDs sort lexicographically by time, so "everything after my checkpoint" is a key
 * comparison — no queue server, no locks, no coordination primitive. Replay is normal
 * operation: reset a checkpoint and everything downstream rebuilds.
 */
export class Journal {
  /**
   * Monotonic, not plain `ulid()`: two events appended inside the same millisecond would
   * otherwise get random entropy and could sort in either order — which would let a
   * consumer resuming from a checkpoint skip an event it never processed.
   */
  private readonly nextId = monotonicFactory();

  constructor(private readonly cache: Cache) {}

  /** Stamps id + ts and appends. Events are facts about the past — never edited (§3). */
  async append(event: NewEvent, now = new Date()): Promise<Event> {
    const stamped = Event.parse({ ...event, id: this.nextId(now.getTime()), ts: now.toISOString() });
    await this.cache.putJSON(journalKey(dayOf(now), stamped.id), stamped);
    return stamped;
  }

  async appendAll(events: NewEvent[], now = new Date()): Promise<Event[]> {
    const written: Event[] = [];
    for (const event of events) written.push(await this.append(event, now));
    return written;
  }

  /**
   * Ordered events strictly after `afterId`. Walks day buckets forward from the
   * checkpoint's day, so a consumer never scans the whole journal to resume.
   */
  async *read(options: {
    afterId?: string | null;
    from?: Date;
    until?: Date;
    limit?: number;
  }): AsyncGenerator<Event> {
    const afterId = options.afterId ?? null;
    const end = options.until ?? new Date();
    const start = options.from ?? (afterId ? new Date(decodeUlidTime(afterId)) : null);
    // A checkpoint (or an explicit window) lets us walk day buckets directly. A fresh
    // consumer has no lower bound, so we discover the days that exist — the one listing
    // a full replay pays for, and the reason day buckets exist at all.
    const days = start ? [...daysBetween(start, end)] : await this.days();
    let emitted = 0;

    for (const day of days) {
      if (day > dayOf(end)) break;
      const keys = await this.cache.list(journalDayPrefix(day));
      for (const key of keys.sort()) {
        const id = key.split('/').pop()?.replace('.json', '') ?? '';
        if (afterId !== null && id <= afterId) continue;
        const raw = await this.cache.getJSON<unknown>(key);
        if (raw === null) continue;
        yield Event.parse(raw);
        emitted += 1;
        if (options.limit !== undefined && emitted >= options.limit) return;
      }
    }
  }

  /** Day buckets that exist, ascending. Only used when replaying from the beginning. */
  async days(): Promise<string[]> {
    const keys = await this.cache.list('journal/');
    return [...new Set(keys.map((key) => key.split('/')[1] ?? ''))].filter(Boolean).sort();
  }

  async checkpoint(consumer: string): Promise<Checkpoint> {
    const stored = await this.cache.getJSON<Checkpoint>(checkpointKey(consumer));
    return (
      stored ?? { consumer, last_event_id: null, updated_at: new Date().toISOString() }
    );
  }

  /**
   * Advance only after the work is durable. A crash before this call means reprocessing,
   * which is fine — every worker is idempotent (§4). Advancing early loses events silently.
   */
  async advance(consumer: string, lastEventId: string): Promise<void> {
    await this.cache.putJSON(checkpointKey(consumer), {
      consumer,
      last_event_id: lastEventId,
      updated_at: new Date().toISOString(),
    } satisfies Checkpoint);
  }

  /** Reset a consumer to the beginning of time. `mise run replay --consumer analyzer`. */
  async reset(consumer: string): Promise<void> {
    await this.cache.putJSON(checkpointKey(consumer), {
      consumer,
      last_event_id: null,
      updated_at: new Date().toISOString(),
    } satisfies Checkpoint);
  }
}

/** ULID Crockford base32: the first 10 chars are the millisecond timestamp. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function decodeUlidTime(id: string): number {
  return [...id.slice(0, 10).toUpperCase()].reduce(
    (time, char) => time * 32 + CROCKFORD.indexOf(char),
    0,
  );
}

function* daysBetween(from: Date, until: Date): Generator<string> {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const last = dayOf(until);
  for (;;) {
    const day = dayOf(cursor);
    yield day;
    if (day >= last) return;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}
