import { Meilisearch, type EnqueuedTaskPromise, type Index } from 'meilisearch';
import {
  REPOS_STATE_INDEX,
  REPOS_STATE_SETTINGS,
  TOOLS_ALIAS,
  TOOLS_SETTINGS,
  TRACES_INDEX,
  TRACES_SETTINGS,
  toolsIndexName,
} from './settings';

export * from './settings';
export * from './keys';

/** Server-side client. The master key never reaches a browser (§12). */
export function createAdminClient(env: NodeJS.ProcessEnv = process.env): Meilisearch {
  return new Meilisearch({
    host: env.MEILI_HOST ?? 'http://localhost:7700',
    apiKey: env.MEILI_MASTER_KEY,
  });
}

/**
 * Meilisearch writes are asynchronous (§5, §14): every write enqueues a task, and a
 * consumer must wait for it to succeed before advancing its checkpoint — otherwise a
 * crash silently loses a batch. Route every write through here.
 */
export async function awaitTask(enqueued: EnqueuedTaskPromise, timeoutMs = 120_000): Promise<void> {
  const task = await enqueued.waitTask({ timeout: timeoutMs, interval: 200 });
  if (task.status !== 'succeeded') {
    throw new Error(`meilisearch task ${task.uid} ${task.status}: ${task.error?.message ?? 'unknown'}`);
  }
}

/** Idempotent: `mise run search:settings`. Never applied to the live alias (§5). */
export async function applySettings(client: Meilisearch, toolsIndex = TOOLS_ALIAS): Promise<void> {
  for (const [uid, settings] of [
    [toolsIndex, TOOLS_SETTINGS],
    [REPOS_STATE_INDEX, REPOS_STATE_SETTINGS],
    [TRACES_INDEX, TRACES_SETTINGS],
  ] as const) {
    // Creating an index that already exists is a failed task, not an error worth stopping for.
    await client
      .createIndex(uid, { primaryKey: 'id' })
      .waitTask()
      .catch(() => null);
    await awaitTask(client.index(uid).updateSettings(settings));
  }
}

/**
 * Full rebuild (§4.3): build `tools_<ts>` from cache, apply settings, verify the document
 * count, swap the alias, keep the previous index for one cycle for instant rollback.
 * Never mutate the live alias; never swap onto a half-built index.
 */
export async function createRebuildIndex(client: Meilisearch): Promise<Index> {
  const uid = toolsIndexName();
  await awaitTask(client.createIndex(uid, { primaryKey: 'id' }));
  await awaitTask(client.index(uid).updateSettings(TOOLS_SETTINGS));
  return client.index(uid);
}

export async function promote(
  client: Meilisearch,
  builtIndex: string,
  expectedCount: number,
): Promise<void> {
  const stats = await client.index(builtIndex).getStats();
  if (stats.numberOfDocuments !== expectedCount) {
    throw new Error(
      `refusing to swap alias: ${builtIndex} has ${stats.numberOfDocuments} documents, expected ${expectedCount}`,
    );
  }
  // rename:false swaps the *contents* of the two indexes, so `tools` keeps its name and
  // the previous corpus survives one cycle under the timestamped uid for instant rollback.
  await awaitTask(client.swapIndexes([{ indexes: [TOOLS_ALIAS, builtIndex], rename: false }]));
}

export { Meilisearch };
