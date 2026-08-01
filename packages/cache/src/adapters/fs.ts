import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

  async put(key: string, body: Buffer | string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
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
