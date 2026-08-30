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
});
