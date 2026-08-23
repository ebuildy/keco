import { buildFilters, MAX_TOTAL_HITS } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { makeTool } from './corpus/builder';
import { runSearch, valuesAt } from './engine';

const corpus = [
  makeTool({ repo: 'a/cli-tool', kind: 'cli', domains: ['security'], stars: 100, k8s_relevance: 0.9 }),
  makeTool({ repo: 'b/an-operator', kind: 'operator', domains: ['storage'], stars: 500, k8s_relevance: 0.9 }),
  makeTool({ repo: 'c/archived-cli', kind: 'cli', domains: ['security'], stars: 900, archived: true, k8s_relevance: 0.9 }),
  makeTool({ repo: 'd/low-relevance', kind: 'cli', domains: ['security'], stars: 700, k8s_relevance: 0.2 }),
  makeTool({
    repo: 'e/brewable', kind: 'cli', domains: ['policy'], stars: 300, k8s_relevance: 0.9,
    install_methods: [{ method: 'brew', command: 'brew install brewable', source_url: 'https://formulae.brew.sh/formula/brewable', verified_at: '2026-08-20T00:00:00.000Z' }],
  }),
];

const names = (hits: { full_name: string }[]) => hits.map((hit) => hit.full_name).sort();

describe('runSearch filters', () => {
  it('applies the default filters buildFilters always emits: not archived, relevance floor', () => {
    const result = runSearch(corpus, { filter: buildFilters({}) });
    expect(names(result.hits)).toEqual(['a/cli-tool', 'b/an-operator', 'e/brewable']);
  });

  it('includes archived documents when the filter permits it', () => {
    const result = runSearch(corpus, { filter: buildFilters({ includeArchived: true }) });
    expect(names(result.hits)).toContain('c/archived-cli');
  });

  it('honours the relevance floor as a number comparison, not a string one', () => {
    const result = runSearch(corpus, { filter: buildFilters({ includeArchived: true, minRelevance: 0.1 }) });
    expect(names(result.hits)).toContain('d/low-relevance');
  });

  it('applies an IN clause on a taxonomy family', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { kind: ['operator'] } }) });
    expect(names(result.hits)).toEqual(['b/an-operator']);
  });

  it('treats multiple values in one IN clause as OR', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { kind: ['cli', 'operator'] } }) });
    expect(names(result.hits)).toEqual(['a/cli-tool', 'b/an-operator', 'e/brewable']);
  });

  it('treats separate clauses as AND', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { kind: ['cli'], domains: ['policy'] } }) });
    expect(names(result.hits)).toEqual(['e/brewable']);
  });

  it('matches an array-of-objects attribute through install_methods.method', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { install_methods: ['brew'] } }) });
    expect(names(result.hits)).toEqual(['e/brewable']);
  });

  it('matches a document whose array attribute contains the value', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { domains: ['security'] } }) });
    expect(names(result.hits)).toEqual(['a/cli-tool']);
  });

  it('throws on an unrecognised filter clause rather than ignoring it', () => {
    expect(() => runSearch(corpus, { filter: ['kind EXISTS'] })).toThrow();
  });

  it('throws when a filter clause names an attribute that is not filterable in production', () => {
    // `forks` is neither a taxonomy family nor in the non-taxonomy filterable list —
    // production would reject this with `invalid_search_filter`.
    expect(() => runSearch(corpus, { filter: ['forks >= 5'] })).toThrow();
  });

  it('treats a quoted IN value as a string literal, never coerced to a number', () => {
    const licensed = [
      makeTool({ repo: 'a/dotted', license: '1.0', k8s_relevance: 0.9 }),
      makeTool({ repo: 'b/bare', license: '1', k8s_relevance: 0.9 }),
    ];
    const result = runSearch(licensed, {
      filter: buildFilters({ includeArchived: true, license: ['1.0'] }),
    });
    expect(names(result.hits)).toEqual(['a/dotted']);
  });
});

describe('runSearch matching, sorting and pagination', () => {
  const searchable = [
    // `name` is derived from `repo`, so it is not an override ToolOverrides accepts.
    makeTool({ repo: 'x/kubectx', summary: 'switch contexts', k8s_relevance: 0.9 }),
    makeTool({ repo: 'y/other', summary: 'a tool that mentions kubectx in its summary', k8s_relevance: 0.9 }),
    makeTool({ repo: 'z/unrelated', summary: 'nothing to see', k8s_relevance: 0.9 }),
  ];

  it('matches an empty query against everything', () => {
    expect(runSearch(searchable, { q: '' }).hits).toHaveLength(3);
  });

  it('matches case-insensitively across searchable fields', () => {
    expect(names(runSearch(searchable, { q: 'KUBECTX' }).hits)).toEqual(['x/kubectx', 'y/other']);
  });

  it('ranks a name match above a summary-only match', () => {
    const hits = runSearch(searchable, { q: 'kubectx' }).hits;
    expect(hits[0]?.full_name).toBe('x/kubectx');
  });

  it('returns nothing for a query that matches nothing', () => {
    const result = runSearch(searchable, { q: 'zzzzz-no-such-tool' });
    expect(result.hits).toEqual([]);
    expect(result.totalHits).toBe(0);
  });

  it('sorts by each spec sortSpec() can emit', () => {
    const sortable = [
      makeTool({ repo: 'a/one', stars: 10, pushed_at: '2020-01-01T00:00:00.000Z', score: { popularity: 0, activity: 0, adoption: 0, quality: 0, quality_coverage: 1, total: 0.1, momentum: 0.9 } }),
      makeTool({ repo: 'b/two', stars: 90, pushed_at: '2026-01-01T00:00:00.000Z', score: { popularity: 0, activity: 0, adoption: 0, quality: 0, quality_coverage: 1, total: 0.9, momentum: 0.1 } }),
    ];
    expect(runSearch(sortable, { sort: ['stars:desc'] }).hits[0]?.full_name).toBe('b/two');
    expect(runSearch(sortable, { sort: ['score.total:desc'] }).hits[0]?.full_name).toBe('b/two');
    expect(runSearch(sortable, { sort: ['score.momentum:desc'] }).hits[0]?.full_name).toBe('a/one');
    expect(runSearch(sortable, { sort: ['pushed_at:desc'] }).hits[0]?.full_name).toBe('b/two');
  });

  it('orders an empty query by score.total descending, the index tie-break (§5)', () => {
    const scored = [
      makeTool({ repo: 'a/low', score: { popularity: 0, activity: 0, adoption: 0, quality: 0, quality_coverage: 1, total: 0.2, momentum: 0 } }),
      makeTool({ repo: 'b/high', score: { popularity: 0, activity: 0, adoption: 0, quality: 0, quality_coverage: 1, total: 0.9, momentum: 0 } }),
    ];
    const hits = runSearch(scored, { q: '' }).hits;
    expect(hits.map((hit) => hit.full_name)).toEqual(['b/high', 'a/low']);
  });

  it('keeps match rank primary under an explicit sort — sort only orders within a rank bucket', () => {
    // Real Meilisearch applies `sort` as its fifth ranking rule, after word/typo/proximity/
    // attribute: it orders *within* relevance buckets, never overrides them.
    const mixed = [
      makeTool({ repo: 'x/kubectx', summary: 'context switcher', stars: 5, k8s_relevance: 0.9 }),
      makeTool({ repo: 'y/other', summary: 'mentions kubectx in passing', stars: 900, k8s_relevance: 0.9 }),
    ];
    const hits = runSearch(mixed, { q: 'kubectx', sort: ['stars:desc'] }).hits;
    expect(hits.map((hit) => hit.full_name)).toEqual(['x/kubectx', 'y/other']);
  });

  it('throws when a sort clause names an attribute that is not sortable in production', () => {
    expect(() => runSearch(corpus, { sort: ['forks:desc'] })).toThrow();
  });

  it('throws when page is less than 1', () => {
    const many = Array.from({ length: 5 }, (_, i) => makeTool({ repo: `org/tool-${i}`, k8s_relevance: 0.9 }));
    expect(() => runSearch(many, { page: -1, hitsPerPage: 20 })).toThrow();
    expect(() => runSearch(many, { page: 0, hitsPerPage: 20 })).toThrow();
  });

  it('paginates, and reports totals over the whole match set', () => {
    const many = Array.from({ length: 45 }, (_, i) => makeTool({ repo: `org/tool-${i}`, k8s_relevance: 0.9 }));
    const second = runSearch(many, { page: 2, hitsPerPage: 20 });
    expect(second.hits).toHaveLength(20);
    expect(second.page).toBe(2);
    expect(second.totalHits).toBe(45);
    expect(second.totalPages).toBe(3);
    expect(runSearch(many, { page: 3, hitsPerPage: 20 }).hits).toHaveLength(5);
  });

  it('clamps the total to MAX_TOTAL_HITS, so paging cannot reach past what totalPages advertises', () => {
    const huge = Array.from({ length: MAX_TOTAL_HITS + 5 }, (_, i) => makeTool({ repo: `org/tool-${i}`, k8s_relevance: 0.9 }));
    const result = runSearch(huge, { hitsPerPage: 20 });
    expect(result.totalHits).toBe(MAX_TOTAL_HITS);
    expect(result.totalPages).toBe(Math.ceil(MAX_TOTAL_HITS / 20));
    const lastPage = runSearch(huge, { hitsPerPage: 20, page: Math.ceil(MAX_TOTAL_HITS / 20) + 1 });
    expect(lastPage.hits).toEqual([]);
  });

  it('returns counts but no hits when hitsPerPage is 0, as browseFacets() requires', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeTool({ repo: `org/t-${i}`, k8s_relevance: 0.9 }));
    const result = runSearch(many, { hitsPerPage: 0 });
    expect(result.hits).toEqual([]);
    expect(result.totalHits).toBe(10);
    expect(result.totalPages).toBe(0);
  });
});

describe('runSearch multi-word query matching', () => {
  const multiWord = [
    makeTool({ repo: 'argoproj/argo-cd', summary: 'Argo CD is a GitOps tool', k8s_relevance: 0.9 }),
    makeTool({ repo: 'z/unrelated', summary: 'nothing to see here', k8s_relevance: 0.9 }),
  ];

  it('matches every query token regardless of order, across fields', () => {
    expect(names(runSearch(multiWord, { q: 'argo cd' }).hits)).toEqual(['argoproj/argo-cd']);
    expect(names(runSearch(multiWord, { q: 'cd argo' }).hits)).toEqual(['argoproj/argo-cd']);
    expect(names(runSearch(multiWord, { q: 'gitops argo' }).hits)).toEqual(['argoproj/argo-cd']);
  });

  it('requires every token to appear somewhere — a doc matching only one token does not match', () => {
    const partial = [makeTool({ repo: 'y/only-argo', summary: 'argo only, no other word here', k8s_relevance: 0.9 })];
    expect(runSearch(partial, { q: 'argo nonexistentterm' }).hits).toEqual([]);
  });
});

describe('runSearch facet distribution', () => {
  const faceted = [
    makeTool({ repo: 'a/one', kind: 'cli', domains: ['security', 'policy'], k8s_relevance: 0.9 }),
    makeTool({ repo: 'b/two', kind: 'cli', domains: ['security'], k8s_relevance: 0.9 }),
    makeTool({ repo: 'c/three', kind: 'operator', domains: ['storage'], k8s_relevance: 0.9 }),
    makeTool({
      repo: 'd/four', kind: 'cli', domains: ['storage'], k8s_relevance: 0.9,
      install_methods: [{ method: 'krew', command: 'kubectl krew install four', source_url: 'https://krew.sigs.k8s.io/plugins/', verified_at: '2026-08-20T00:00:00.000Z' }],
    }),
  ];

  it('counts documents per value for a scalar attribute', () => {
    const result = runSearch(faceted, { facets: ['kind'] });
    expect(result.facetDistribution.kind).toEqual({ cli: 3, operator: 1 });
  });

  it('counts each value of a list attribute once per document', () => {
    const result = runSearch(faceted, { facets: ['domains'] });
    expect(result.facetDistribution.domains).toEqual({ security: 2, policy: 1, storage: 2 });
  });

  it('counts a projected attribute through an array of objects', () => {
    const result = runSearch(faceted, { facets: ['install_methods.method'] });
    expect(result.facetDistribution['install_methods.method']).toEqual({ krew: 1 });
  });

  it('counts over the filtered set, not the whole corpus', () => {
    const result = runSearch(faceted, { filter: ['kind IN ["operator"]'], facets: ['domains'] });
    expect(result.facetDistribution.domains).toEqual({ storage: 1 });
  });

  it('counts over the query-matched set, not the whole corpus — searchTools facets on every keystroke', () => {
    const queryFaceted = [
      makeTool({ repo: 'x/kubectx-cli', kind: 'cli', summary: 'kubectx context switcher', k8s_relevance: 0.9 }),
      makeTool({ repo: 'y/unrelated-op', kind: 'operator', summary: 'nothing to do with it', k8s_relevance: 0.9 }),
    ];
    const result = runSearch(queryFaceted, { q: 'kubectx', facets: ['kind'] });
    expect(result.facetDistribution.kind).toEqual({ cli: 1 });
  });

  it('counts a document with the same facet value twice only once', () => {
    const dup = [
      makeTool({
        repo: 'a/dup', k8s_relevance: 0.9,
        install_methods: [
          { method: 'brew', command: 'brew install dup', source_url: 'https://formulae.brew.sh/formula/dup', verified_at: '2026-08-20T00:00:00.000Z' },
          { method: 'brew', command: 'brew install dup-again', source_url: 'https://formulae.brew.sh/formula/dup-again', verified_at: '2026-08-20T00:00:00.000Z' },
        ],
      }),
    ];
    const result = runSearch(dup, { facets: ['install_methods.method'] });
    expect(result.facetDistribution['install_methods.method']).toEqual({ brew: 1 });
  });

  it('drops a null value from a facet distribution instead of counting a "null" bucket', () => {
    const withNull = [makeTool({ repo: 'a/one', language: null, k8s_relevance: 0.9 })];
    const result = runSearch(withNull, { facets: ['language'] });
    expect(result.facetDistribution.language).toEqual({});
  });

  it('throws when a facet names an attribute that is not filterable/facetable in production', () => {
    expect(() => runSearch(faceted, { facets: ['summary'] })).toThrow();
  });

  it('omits nothing and invents nothing when no facets are requested', () => {
    expect(runSearch(faceted, {}).facetDistribution).toEqual({});
  });
});

describe('valuesAt', () => {
  it('does not walk the prototype chain for an unset/typo attribute', () => {
    const tool = makeTool({ repo: 'a/one', k8s_relevance: 0.9 });
    expect(valuesAt(tool, 'constructor')).toEqual([]);
    expect(valuesAt(tool, 'toString')).toEqual([]);
  });
});
