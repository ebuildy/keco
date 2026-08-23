import { buildFilters } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { makeTool } from './corpus/builder';
import { runSearch } from './engine';

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

  it('paginates, and reports totals over the whole match set', () => {
    const many = Array.from({ length: 45 }, (_, i) => makeTool({ repo: `org/tool-${i}`, k8s_relevance: 0.9 }));
    const second = runSearch(many, { page: 2, hitsPerPage: 20 });
    expect(second.hits).toHaveLength(20);
    expect(second.page).toBe(2);
    expect(second.totalHits).toBe(45);
    expect(second.totalPages).toBe(3);
    expect(runSearch(many, { page: 3, hitsPerPage: 20 }).hits).toHaveLength(5);
  });

  it('returns counts but no hits when hitsPerPage is 0, as browseFacets() requires', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeTool({ repo: `org/t-${i}`, k8s_relevance: 0.9 }));
    const result = runSearch(many, { hitsPerPage: 0 });
    expect(result.hits).toEqual([]);
    expect(result.totalHits).toBe(10);
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

  it('omits nothing and invents nothing when no facets are requested', () => {
    expect(runSearch(faceted, {}).facetDistribution).toEqual({});
  });
});
