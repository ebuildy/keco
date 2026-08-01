/**
 * The storage port. Object storage in production (R2/MinIO/S3), the local filesystem in
 * dev — one adapter, no database, no index (AGENTS.md §3).
 *
 * `list` exists for the journal and for full rebuilds only. Never list to find work:
 * that is what the journal and checkpoints are for (§3, §14).
 */
export interface Storage {
  get(key: string): Promise<Buffer | null>;
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
