import { describe, expect, it } from 'vitest';
import { isIndexNotFound, planIndexCreate } from './create-index';

/**
 * `engine index create` is the one command here that may run against production, so what it
 * does to an index that already holds a corpus is the whole risk surface. §5: a settings change
 * reindexes, and it must never be applied to the live alias.
 */
describe('planIndexCreate', () => {
  it('creates and configures an index that does not exist', () => {
    expect(planIndexCreate({ exists: false, documents: 0, forceSettings: false })).toEqual({
      create: true,
      applySettings: true,
      reason: 'index does not exist',
    });
  });

  it('configures an existing empty index without recreating it', () => {
    expect(planIndexCreate({ exists: true, documents: 0, forceSettings: false })).toMatchObject({
      create: false,
      applySettings: true,
    });
  });

  it('refuses to reindex a populated index by default', () => {
    const plan = planIndexCreate({ exists: true, documents: 30_000, forceSettings: false });
    expect(plan).toMatchObject({ create: false, applySettings: false });
    expect(plan.reason).toMatch(/30000 documents/);
    expect(plan.reason).toMatch(/swap the alias/);
  });

  it('reindexes a populated index only when forced', () => {
    const plan = planIndexCreate({ exists: true, documents: 30_000, forceSettings: true });
    expect(plan).toMatchObject({ create: false, applySettings: true });
    expect(plan.reason).toMatch(/--force-settings/);
  });

  it('never recreates an index that exists, whatever the flags', () => {
    for (const documents of [0, 1, 30_000]) {
      for (const forceSettings of [true, false]) {
        expect(planIndexCreate({ exists: true, documents, forceSettings }).create).toBe(false);
      }
    }
  });
});

describe('isIndexNotFound', () => {
  it('recognises the missing-index error', () => {
    expect(isIndexNotFound({ cause: { code: 'index_not_found' } })).toBe(true);
  });

  /**
   * The bug this exists to prevent: treating a rejected request as an absent index creates an
   * index over a live one, or silently "succeeds" against the wrong host.
   */
  it.each([
    ['a bad API key', { cause: { code: 'invalid_api_key' } }],
    ['a connection failure', new TypeError('fetch failed')],
    ['null', null],
    ['undefined', undefined],
  ])('does not mistake %s for a missing index', (_label, error) => {
    expect(isIndexNotFound(error)).toBe(false);
  });
});
