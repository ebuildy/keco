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
      // A flush with nothing buffered is normal, not exceptional.
      await withStore(async (store) => {
        await store.put(WIDGETS, [], { durable: true });
        expect(await store.count(WIDGETS)).toBe(0);
      });
    });

    it('refuses remove with an empty filter instead of emptying the collection', async () => {
      // The dangerous direction: `matchesWhere` treats {} as "match everything", so without
      // this an accidentally-empty filter silently wipes the corpus on some backends and
      // errors on others.
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
      // Unpinned until now, and it is the load-bearing contract for the in-memory store's
      // role as a test double: a backend that hands back a live reference lets a worker
      // silently persist a mutation in memory-backed tests that would not persist against a
      // real backend. That failure mode is other tasks' tests passing when they should not.
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
      // An unknown collection is a programming error, not a miss: `ensure` runs at startup
      // with a static list. Backends must agree on this — one returning null where the
      // others throw turns a typo into a silent empty result.
      await withStore(async (store) => {
        await expect(store.get('never_ensured', 'a')).rejects.toThrow();
        await expect(store.count('never_ensured')).rejects.toThrow();
        await expect(collect(store.list('never_ensured'))).rejects.toThrow();
        await expect(store.put('never_ensured', [{ id: 'a' }])).rejects.toThrow();
        await expect(store.remove('never_ensured', { group: 'x' })).rejects.toThrow();
      });
    });

    it('writes nothing when any document in a batch is invalid', async () => {
      // The batch is atomic. Without this a backend can leave a partial write behind, and the
      // primary-key test above would not notice because it uses a single-document batch.
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
      // The filesystem store stringifies and Meilisearch sends JSON over HTTP, so neither can
      // return a Date, a NaN or an undefined-valued key. An implementation that CAN — the
      // in-memory one, if it used structuredClone — is the dangerous kind of wrong: code doing
      // `doc.when.toISOString()` after a read would pass in tests and throw in production.
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
