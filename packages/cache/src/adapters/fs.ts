import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Storage } from '../storage';

/** Local filesystem adapter — the whole write model today, and it needs no infra. */
export class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, ...key.split('/'));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Write-then-rename. The body lands at a sibling temp path first; `rename` — atomic on
   * POSIX within one filesystem — is what publishes it under `key`. A reader (or a crash)
   * never observes a partial body: `get(key)` returns either the previous complete write or
   * the new one, never bytes in between. This is the atomicity `Storage.put` documents and
   * every caller is entitled to assume — see storage.ts. It also matches what object storage
   * gives for free (a PUT there is already atomic), so the eventual S3 adapter needs no new
   * behavior here, only the same guarantee under a different implementation.
   *
   * A `.tmp-` file can still be orphaned if the process dies between `writeFile` succeeding
   * and `rename` running — that's an acceptable, harmless leak (dead bytes, never a live
   * key), and `list()` below filters it out so it can never be mistaken for real content.
   */
  async put(key: string, body: Buffer | string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tmp, body);
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.path(prefix.endsWith('/') ? prefix : `${prefix}/`);
    let entries: string[];
    try {
      const found = await readdir(base, { recursive: true, withFileTypes: true });
      entries = found
        .filter((entry) => entry.isFile())
        // An orphaned temp file from a `put()` killed between write and rename (see above)
        // must never surface as a real key — the journal and full rebuilds walk this list.
        .filter((entry) => !entry.name.includes('.tmp-'))
        .map((entry) => join(entry.parentPath, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries.map((path) => relative(this.root, path).split(sep).join('/')).sort();
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
