import { describe, expect, it } from 'vitest';
import { settingsFor, settingsMatch, toFilter } from './data-store';

describe('toFilter', () => {
  it('is undefined for no predicate, so getDocuments returns everything', () => {
    expect(toFilter(undefined)).toBeUndefined();
    expect(toFilter({})).toBeUndefined();
  });

  it('quotes strings and joins with AND', () => {
    expect(toFilter({ query_slug: 'kubernetes', archived: false })).toBe(
      'query_slug = "kubernetes" AND archived = false',
    );
  });

  it('leaves numbers and booleans unquoted', () => {
    expect(toFilter({ stars: 100 })).toBe('stars = 100');
    expect(toFilter({ fork: true })).toBe('fork = true');
  });

  it('escapes quotes and backslashes so a value cannot break out of the filter', () => {
    expect(toFilter({ name: 'a"b' })).toBe('name = "a\\"b"');
    expect(toFilter({ name: 'a\\b' })).toBe('name = "a\\\\b"');
  });
});

describe('settingsFor', () => {
  it('maps a spec onto the three attribute lists', () => {
    expect(
      settingsFor({
        name: 'widgets',
        primaryKey: 'id',
        filterable: ['group'],
        sortable: ['rank'],
        searchable: ['name'],
      }),
    ).toEqual({
      filterableAttributes: ['group'],
      sortableAttributes: ['rank'],
      searchableAttributes: ['name'],
    });
  });

  it('defaults searchable to [], making the collection a plain key-value store', () => {
    // AGENTS.md §5: this is what keeps a non-corpus collection out of the inverted index.
    expect(settingsFor({ name: 'runs', primaryKey: 'run_id' })).toEqual({
      filterableAttributes: [],
      sortableAttributes: [],
      searchableAttributes: [],
    });
  });
});

describe('settingsMatch', () => {
  const desired = {
    filterableAttributes: ['group'],
    sortableAttributes: ['rank'],
    searchableAttributes: ['name'],
  };

  it('is true when the managed attributes already agree', () => {
    expect(settingsMatch({ ...desired, typoTolerance: { enabled: true } }, desired)).toBe(true);
  });

  it('ignores ordering, which Meilisearch does not preserve', () => {
    expect(
      settingsMatch({ ...desired, filterableAttributes: ['group'] }, { ...desired, filterableAttributes: ['group'] }),
    ).toBe(true);
  });

  it('is false when an attribute list differs', () => {
    expect(settingsMatch({ ...desired, sortableAttributes: [] }, desired)).toBe(false);
  });

  it('is false when the index reports nothing yet', () => {
    expect(settingsMatch({}, desired)).toBe(false);
  });
});
