import { describe, expect, it } from 'vitest';
import { assertDocumentId, compareBySort, matchesWhere, projectFields } from './data-store';

describe('matchesWhere', () => {
  it('is true when every field matches', () => {
    expect(matchesWhere({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
  });

  it('is false when any field differs', () => {
    expect(matchesWhere({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toBe(false);
  });

  it('is false when a field is absent, rather than matching undefined', () => {
    expect(matchesWhere({ a: 1 }, { missing: 'x' })).toBe(false);
  });

  it('is true for an absent or empty predicate', () => {
    expect(matchesWhere({ a: 1 }, undefined)).toBe(true);
    expect(matchesWhere({ a: 1 }, {})).toBe(true);
  });

  it('compares strictly, so 1 does not match "1"', () => {
    expect(matchesWhere({ a: 1 }, { a: '1' as unknown as number })).toBe(false);
  });
});

describe('projectFields', () => {
  it('keeps only the named fields', () => {
    expect(projectFields({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('omits a named field the document does not have, rather than adding undefined', () => {
    expect(projectFields({ a: 1 }, ['a', 'nope'])).toEqual({ a: 1 });
  });

  it('returns the whole document when no fields are named', () => {
    expect(projectFields({ a: 1, b: 2 }, undefined)).toEqual({ a: 1, b: 2 });
  });
});

describe('assertDocumentId', () => {
  it('accepts letters, digits, hyphens and underscores', () => {
    expect(() => assertDocumentId('kubernetes_20038725', 'widgets', 'id')).not.toThrow();
    expect(() => assertDocumentId('a-b_C9', 'widgets', 'id')).not.toThrow();
  });

  it('rejects a separator that a backend would refuse, naming the collection and field', () => {
    // Meilisearch primary keys allow only [a-zA-Z0-9_-]; a colon is the obvious id separator
    // to reach for and it silently fails at write time, far from the code that chose it.
    expect(() => assertDocumentId('kubernetes:1', 'widgets', 'id')).toThrow(/widgets\.id/);
    expect(() => assertDocumentId('a/b', 'widgets', 'id')).toThrow();
    expect(() => assertDocumentId('a.b', 'widgets', 'id')).toThrow();
  });

  it('rejects an empty id and an undefined one', () => {
    expect(() => assertDocumentId('', 'widgets', 'id')).toThrow(/widgets\.id/);
    expect(() => assertDocumentId('undefined', 'widgets', 'id')).toThrow(/missing/);
  });

  it('rejects a genuinely undefined id, not just the string "undefined"', () => {
    // RegExp.test(undefined) coerces to "undefined" and passes, so the charset check alone
    // does not catch a missing primary key.
    expect(() => assertDocumentId(undefined, 'widgets', 'id')).toThrow(/missing/);
    expect(() => assertDocumentId(42, 'widgets', 'id')).toThrow(/missing/);
  });

  it('rejects an id past the filesystem-safe length bound', () => {
    const tooLong = 'a'.repeat(256);
    expect(() => assertDocumentId(tooLong, 'widgets', 'id')).toThrow(/widgets\.id/);
    expect(() => assertDocumentId('a'.repeat(255), 'widgets', 'id')).not.toThrow();
  });
});

describe('compareBySort', () => {
  const docs = () => [
    { id: 'b', rank: 2, name: 'beta' },
    { id: 'a', rank: 1, name: 'alpha' },
    { id: 'c', rank: 2, name: 'gamma' },
  ];

  it('sorts ascending', () => {
    const sorted = docs().sort(compareBySort([['rank', 'asc']]));
    expect(sorted.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts descending', () => {
    const sorted = docs().sort(compareBySort([['rank', 'desc']]));
    expect(sorted.map((d) => d.rank)).toEqual([2, 2, 1]);
  });

  it('falls through to the next key on a tie', () => {
    const sorted = docs().sort(compareBySort([['rank', 'desc'], ['name', 'asc']]));
    expect(sorted.map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders missing values last regardless of direction or input order', () => {
    const present = { id: 'y', rank: 5 };
    const absent = { id: 'x' };
    const nulled = { id: 'z', rank: null };
    for (const dir of ['asc', 'desc'] as const) {
      const cmp = compareBySort([['rank', dir]]);
      expect([absent, present].sort(cmp).map((d) => d.id)).toEqual(['y', 'x']);
      expect([present, absent].sort(cmp).map((d) => d.id)).toEqual(['y', 'x']);
    }
    // null and absent are one equivalence class: they must compare equal both ways, or the
    // sorted order depends on input order.
    const cmp = compareBySort([['rank', 'asc']]);
    expect(cmp(absent, nulled)).toBe(0);
    expect(cmp(nulled, absent)).toBe(0);
  });

  it('compares strings by codepoint, not locale', () => {
    const rows = [{ id: 'B' }, { id: 'a' }];
    expect(rows.sort(compareBySort([['id', 'asc']])).map((d) => d.id)).toEqual(['B', 'a']);
  });
});
