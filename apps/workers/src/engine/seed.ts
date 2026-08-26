import type { ToolDocument } from '@keco/core';

/**
 * The seeding loop, with no Meilisearch client in sight so it can be tested without one.
 * `submit` is where the caller puts `awaitTask(index.addDocuments(batch))`.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Fabricated `brew install` lines in front of real readers is the worst bug this project can
 * ship (§6), and the portal's mock has five layers keeping it out of a production *bundle*.
 * This is the equivalent layer for the *index*: seeding is refused unless the target is a local
 * Meilisearch. `--force` exists because a containerised dev stack reaches it by another name,
 * and it is deliberately a thing you have to type.
 */
export function assertSeedTarget(host: string, force: boolean): void {
  let hostname: string;
  try {
    // URL keeps IPv6 literals bracketed; strip them so the set above reads as addresses.
    hostname = new URL(host).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error(`MEILI_HOST is not a URL: ${JSON.stringify(host)}`);
  }

  if (force || LOCAL_HOSTNAMES.has(hostname)) return;

  throw new Error(
    `refusing to seed fabricated documents into ${host} — it is not a local Meilisearch. ` +
      'Pass --force if you are certain this instance is disposable.',
  );
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`batch size must be a positive integer, got ${size}`);
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export type SeedOptions = {
  batchSize: number;
  /** Must not resolve until the write is durable — Meilisearch writes are async (§5, §14). */
  submit: (batch: ToolDocument[]) => Promise<void>;
  onBatch?: (batchNumber: number, documentsSent: number) => void;
};

/** Returns the number of documents submitted. Throws on the first batch that fails. */
export async function seedDocuments(
  documents: readonly ToolDocument[],
  { batchSize, submit, onBatch }: SeedOptions,
): Promise<number> {
  let sent = 0;
  const batches = chunk(documents, batchSize);

  for (const [index, batch] of batches.entries()) {
    await submit(batch);
    sent += batch.length;
    onBatch?.(index + 1, sent);
  }

  return sent;
}
