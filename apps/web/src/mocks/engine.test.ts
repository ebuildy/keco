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
