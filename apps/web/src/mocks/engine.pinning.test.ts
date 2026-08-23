import { allValues, buildFilters, defaultFacets, facetableFamilies, familyAttribute, sortSpec } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { MOCK_CORPUS } from './corpus/index';
import { runSearch, valuesAt } from './engine';

/**
 * The mock engine must handle everything the shared read-side algebra can emit. This test is
 * driven by taxonomy.yaml and by SortKey, so adding a family or a sort fails here rather than
 * producing wrong results in dev.
 */
const SORT_KEYS = ['relevance', 'stars', 'score', 'momentum', 'recent'] as const;

describe('the mock engine covers the whole read-side algebra', () => {
  it('resolves every attribute defaultFacets() can name', () => {
    for (const attribute of defaultFacets()) {
      const resolvable = MOCK_CORPUS.some((tool) => valuesAt(tool, attribute).length > 0);
      expect(resolvable, `no document resolves ${attribute}`).toBe(true);
    }
  });

  it('produces a non-empty facet distribution for every facetable family', () => {
    const result = runSearch(MOCK_CORPUS, { facets: defaultFacets() });
    for (const familyId of facetableFamilies()) {
      const attribute = familyAttribute(familyId);
      expect(Object.keys(result.facetDistribution[attribute] ?? {}).length, `${attribute} has no counts`).toBeGreaterThan(0);
    }
  });

  it('evaluates an IN filter for every facetable family without throwing', () => {
    for (const familyId of facetableFamilies()) {
      const first = allValues(familyId)[0];
      expect(first, `${familyId} declares no values`).toBeDefined();
      const filter = buildFilters({ filters: { [familyId]: [first?.id ?? ''] } });
      expect(() => runSearch(MOCK_CORPUS, { filter })).not.toThrow();
    }
  });

  it('accepts every spec sortSpec() can emit', () => {
    for (const key of SORT_KEYS) {
      const sort = sortSpec(key);
      const result = runSearch(MOCK_CORPUS, { sort, hitsPerPage: 5 });
      expect(result.hits.length, `sort=${key} returned nothing`).toBeGreaterThan(0);
    }
  });

  it('rejects a filter clause it does not model, rather than ignoring it', () => {
    expect(() => runSearch(MOCK_CORPUS, { filter: ['stars TO 500'] })).toThrow(/unsupported filter clause/);
  });
});
