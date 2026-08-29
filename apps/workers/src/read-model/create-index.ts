import { awaitTask, TOOLS_SETTINGS, type Meilisearch } from '@keco/search';

/**
 * `engine index create` — bring an index into existence with the real `tools` settings.
 *
 * Unlike seeding, this is safe to run against production: creating an index is how a fresh
 * deployment is bootstrapped, and applying settings to an empty index costs nothing.
 *
 * What is *not* safe is re-applying settings to an index that already holds documents. A
 * settings change reindexes the whole corpus, and §5 is explicit that this must never happen on
 * the live alias — settings belong on the new index, before the swap. So the command decides
 * what to do from the index's actual state rather than doing the same thing everywhere.
 */

export type IndexState = {
  exists: boolean;
  /** Documents already in the index. Only meaningful when `exists`. */
  documents: number;
  forceSettings: boolean;
};

export type IndexPlan = {
  create: boolean;
  applySettings: boolean;
  reason: string;
};

export function planIndexCreate({ exists, documents, forceSettings }: IndexState): IndexPlan {
  if (!exists) {
    return { create: true, applySettings: true, reason: 'index does not exist' };
  }
  if (documents === 0) {
    return { create: false, applySettings: true, reason: 'index exists and is empty' };
  }
  if (forceSettings) {
    return {
      create: false,
      applySettings: true,
      reason: `--force-settings: reindexing ${documents} documents in place`,
    };
  }
  return {
    create: false,
    applySettings: false,
    reason:
      `index already holds ${documents} documents — applying settings would reindex the live ` +
      'corpus (§5). Build a new index and swap the alias, or pass --force-settings if this ' +
      'index is disposable',
  };
}

/**
 * Meilisearch answers "no such index" and "your key is wrong" with the same rejected promise
 * shape, so a bare `.catch(() => null)` reads a bad key, a wrong host or a dead server as an
 * absent index — and then tries to create one over it. Only `index_not_found` means missing;
 * everything else has to propagate.
 */
export const isIndexNotFound = (error: unknown): boolean =>
  (error as { cause?: { code?: string } } | null)?.cause?.code === 'index_not_found';

/** One request, not two: `getStats` on a missing index is itself the existence check. */
export async function readIndexState(
  client: Meilisearch,
  uid: string,
): Promise<{ exists: boolean; documents: number }> {
  try {
    const stats = await client.index(uid).getStats();
    return { exists: true, documents: stats.numberOfDocuments };
  } catch (error) {
    if (isIndexNotFound(error)) return { exists: false, documents: 0 };
    throw error;
  }
}

/** Applies a plan. Returns it, so the caller can report what was actually done. */
export async function createIndex(
  client: Meilisearch,
  uid: string,
  forceSettings: boolean,
): Promise<IndexPlan> {
  const { exists, documents } = await readIndexState(client, uid);
  const plan = planIndexCreate({ exists, documents, forceSettings });

  if (plan.create) await awaitTask(client.createIndex(uid, { primaryKey: 'id' }));
  if (plan.applySettings) await awaitTask(client.index(uid).updateSettings(TOOLS_SETTINGS));

  return plan;
}
