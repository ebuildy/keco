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

  it('returns null for a traversal-shaped id rather than reading outside the collection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'keco-datastore-'));
    try {
      const storage = new FsStorage(dir);
      // A secret that lives outside any collection's data tree entirely.
      await storage.put('SECRET.json', JSON.stringify({ leaked: true }));

      const store = new FsDataStore(storage);
      await store.ensure([{ name: 'widgets', primaryKey: 'id' }]);

      expect(await store.get('widgets', '../SECRET')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a document whose file does not parse as JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'keco-datastore-'));
    try {
      const storage = new FsStorage(dir);
      const store = new FsDataStore(storage);
      await store.ensure([{ name: 'widgets', primaryKey: 'id' }]);
      await storage.put('data/widgets/a.json', 'not valid json');

      await expect(store.get('widgets', 'a')).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes the file it actually read, not one rebuilt from a mismatched id field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'keco-datastore-'));
    try {
      const storage = new FsStorage(dir);
      const store = new FsDataStore(storage);
      await store.ensure([{ name: 'widgets', primaryKey: 'id', filterable: ['group'] }]);

      // Hand-written directly through Storage, bypassing `put` (which would reject an id
      // that disagrees with the key it's stored under) — this is exactly the "hand-edited
      // file" scenario the store's audience produces.
      await storage.put('data/widgets/a.json', JSON.stringify({ id: 'b', group: 'x' }));

      await store.remove('widgets', { group: 'x' });

      expect(await storage.get('data/widgets/a.json')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
