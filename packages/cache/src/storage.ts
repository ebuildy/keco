/**
 * The storage port. One adapter today — the local filesystem — with no database and no
 * index (AGENTS.md §3). The port exists so object storage (R2/S3) can slot in for v2
 * without any caller changing; see ROADMAP.md.
 *
 * `list` exists for the journal and for full rebuilds only. Never list to find work:
 * that is what the journal and checkpoints are for (§3, §14).
 */
export interface Storage {
  get(key: string): Promise<Buffer | null>;
  /**
   * Atomic. A `get(key)` issued at any point — including by a process that crashes mid-call
   * — observes either the previous complete value or the new one, never a truncated or
   * partial body. Callers build on this: a multi-file flush (e.g. the discovery worker's
   * list/hashes/state, apps/workers/src/discovery/store.ts) relies on each individual `put`
   * being all-or-nothing so it only has to reason about *ordering* between files, not about
   * a single file tearing mid-write. `FsStorage` gets this from write-then-rename; any future
   * adapter must provide the same guarantee (most object storage already does, natively).
   */
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Keys under a prefix, lexicographically ordered. */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export class Cache {
  constructor(private readonly storage: Storage) {}

  async getJSON<T>(key: string): Promise<T | null> {
    const buf = await this.storage.get(key);
    if (buf === null) return null;
    return JSON.parse(buf.toString('utf8')) as T;
  }

  async putJSON(key: string, value: unknown): Promise<void> {
    await this.storage.put(key, JSON.stringify(value), 'application/json');
  }

  async getText(key: string): Promise<string | null> {
    const buf = await this.storage.get(key);
    return buf === null ? null : buf.toString('utf8');
  }

  async putText(key: string, value: string, contentType = 'text/plain'): Promise<void> {
    await this.storage.put(key, value, contentType);
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    return this.storage.get(key);
  }

  /** Binary blobs — icons today. `putText` would corrupt them: it encodes as UTF-8. */
  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.storage.put(key, body, contentType);
  }

  has(key: string): Promise<boolean> {
    return this.storage.has(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.storage.list(prefix);
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }
}

/** A cached third-party response and the metadata that makes its TTL enforceable (§4.2). */
export type ExternalEnvelope<T> = {
  fetched_at: string;
  ttl_seconds: number;
  status: number;
  body: T | null;
};

export const isFresh = (envelope: ExternalEnvelope<unknown>, now = new Date()): boolean =>
  now.getTime() - new Date(envelope.fetched_at).getTime() < envelope.ttl_seconds * 1000;
