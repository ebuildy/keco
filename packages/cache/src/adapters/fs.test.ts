import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsStorage } from './fs';

// `put()` is write-then-rename (see the guarantee documented on `Storage.put` in
// storage.ts). Mocking `writeFile` lets these tests fail the write to the *temp* path
// without needing a real filesystem crash, which vitest has no way to simulate directly.
// Every other node:fs/promises export passes straight through to the real implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

import { writeFile } from 'node:fs/promises';

describe('FsStorage.put', () => {
  let dir: string;
  let storage: FsStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keco-fsstorage-'));
    storage = new FsStorage(dir);
    vi.mocked(writeFile).mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fully replaces existing content on a normal write', async () => {
    await storage.put('k.txt', 'first');
    await storage.put('k.txt', 'second');
    expect((await storage.get('k.txt'))?.toString('utf8')).toBe('second');
  });

  it('leaves the previous value at that key fully intact when the write fails', async () => {
    await storage.put('k.txt', 'original');

    vi.mocked(writeFile).mockRejectedValueOnce(new Error('simulated disk failure'));
    await expect(storage.put('k.txt', 'new value')).rejects.toThrow('simulated disk failure');

    // Never a truncated or half-written body — either the old bytes, unchanged, or nothing.
    expect((await storage.get('k.txt'))?.toString('utf8')).toBe('original');
  });

  it('never creates the target at all when the first write to a new key fails', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('simulated disk failure'));
    await expect(storage.put('new-key.txt', 'value')).rejects.toThrow();
    expect(await storage.get('new-key.txt')).toBeNull();
  });

  it('does not leak the temp file behind a failed write', async () => {
    await storage.put('k.txt', 'original');
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('simulated disk failure'));
    await expect(storage.put('k.txt', 'new value')).rejects.toThrow();

    const files = await readdir(dir);
    expect(files.some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('list() ignores an orphaned temp file left by a rename that never ran', async () => {
    await storage.put('a/b.json', '{}');
    // Simulates the one failure mode put()'s own cleanup can't reach: the process is killed
    // between writeFile succeeding and rename running, so a real temp file survives on disk.
    await writeFile(join(dir, 'a', 'orphan.json.tmp-1234-deadbeef'), 'partial');

    expect(await storage.list('a')).toEqual(['a/b.json']);
  });
});
