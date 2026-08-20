import { describe, expect, it } from 'vitest';
import type { Key, KeyCreation, KeysResults, Meilisearch } from 'meilisearch';
import { ensureSearchOnlyKey, SEARCH_KEY_DESCRIPTION } from './keys';

/** A minimal fake standing in for the two Meilisearch client methods this module calls. */
function fakeClient(existingKeys: Key[] = []) {
  const created: KeyCreation[] = [];
  const client = {
    getKeys: async (): Promise<KeysResults> =>
      ({ results: existingKeys, offset: 0, limit: 100, total: existingKeys.length }) as KeysResults,
    createKey: async (params: KeyCreation): Promise<Key> => {
      created.push(params);
      return {
        uid: 'new-uid',
        description: params.description ?? null,
        name: params.name ?? null,
        key: 'minted-key-value',
        actions: params.actions,
        indexes: params.indexes,
        expiresAt: params.expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Key;
    },
  };
  return { client: client as unknown as Meilisearch, created };
}

describe('ensureSearchOnlyKey', () => {
  it('mints a key scoped to search-only actions on exactly the tools index', async () => {
    const { client, created } = fakeClient();
    const key = await ensureSearchOnlyKey(client, 'tools');
    expect(key).toBe('minted-key-value');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      description: SEARCH_KEY_DESCRIPTION,
      actions: ['search'],
      indexes: ['tools'],
    });
    // Never scoped to every index, and never any write action — the browser bundle ships
    // this value to strangers (§12).
    expect(created[0]!.actions).not.toContain('*');
    expect(created[0]!.indexes).not.toContain('*');
  });

  it('reuses a previously-minted key instead of creating a second one', async () => {
    const existing = {
      uid: 'existing-uid',
      description: SEARCH_KEY_DESCRIPTION,
      name: null,
      key: 'already-there',
      actions: ['search'],
      indexes: ['tools'],
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Key;
    const { client, created } = fakeClient([existing]);
    const key = await ensureSearchOnlyKey(client, 'tools');
    expect(key).toBe('already-there');
    expect(created).toHaveLength(0);
  });

  it('does not mistake an unrelated key for the one it manages', async () => {
    const unrelated = {
      uid: 'unrelated',
      description: 'Default Search API Key',
      name: null,
      key: 'unrelated-key',
      actions: ['search'],
      indexes: ['*'],
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Key;
    const { client, created } = fakeClient([unrelated]);
    const key = await ensureSearchOnlyKey(client, 'tools');
    expect(key).toBe('minted-key-value');
    expect(created).toHaveLength(1);
  });
});
