import { describe, expect, it } from 'vitest';
import { buildFilters, defaultFacets, selectionFromParams } from './filters';

describe('buildFilters', () => {
  it('always excludes archived tools and gates on relevance', () => {
    expect(buildFilters({})).toEqual(['archived = false', 'k8s_relevance >= 0.4']);
  });

  it('includes archived tools when asked', () => {
    expect(buildFilters({ includeArchived: true })).toEqual(['k8s_relevance >= 0.4']);
  });

  it('honours a custom relevance floor', () => {
    expect(buildFilters({ minRelevance: 0 })).toContain('k8s_relevance >= 0');
  });

  it('emits one IN clause per selected family', () => {
    const filters = buildFilters({ filters: { kind: ['cli'], domains: ['security', 'policy'] } });
    expect(filters).toContain('kind IN ["cli"]');
    expect(filters).toContain('domains IN ["security", "policy"]');
  });

  it('nests the install method attribute', () => {
    expect(buildFilters({ filters: { install_methods: ['krew'] } })).toContain(
      'install_methods.method IN ["krew"]',
    );
  });

  it('ignores an empty selection', () => {
    expect(buildFilters({ filters: { kind: [] } })).not.toContainEqual(expect.stringContaining('kind IN'));
  });

  it('ignores a family that is not in the taxonomy', () => {
    expect(buildFilters({ filters: { nonsense: ['x'] } })).not.toContainEqual(
      expect.stringContaining('nonsense'),
    );
  });

  it('filters on language and license, which are not families', () => {
    const filters = buildFilters({ language: ['Go'], license: ['Apache-2.0'] });
    expect(filters).toContain('language IN ["Go"]');
    expect(filters).toContain('license IN ["Apache-2.0"]');
  });
});

describe('defaultFacets', () => {
  it('asks for every facetable family', () => {
    expect(defaultFacets()).toContain('kind');
    expect(defaultFacets()).toContain('install_methods.method');
    expect(defaultFacets()).toContain('governance');
  });
});

describe('selectionFromParams', () => {
  it('reads each family from its declared URL parameter', () => {
    const selection = selectionFromParams({ domain: 'security,policy', kind: 'cli', install: 'krew' });
    expect(selection).toEqual({ domains: ['security', 'policy'], kind: ['cli'], install_methods: ['krew'] });
  });

  it('accepts repeated parameters as arrays', () => {
    expect(selectionFromParams({ domain: ['security', 'policy'] })).toEqual({
      domains: ['security', 'policy'],
    });
  });

  it('drops values that are not in the taxonomy', () => {
    expect(selectionFromParams({ kind: 'cli,wasm-module' })).toEqual({ kind: ['cli'] });
  });

  it('drops unknown parameters and empty values', () => {
    expect(selectionFromParams({ q: 'ingress', domain: '', nope: 'x' })).toEqual({});
  });

  it('rejects a value that belongs to a different family', () => {
    expect(selectionFromParams({ kind: 'security' })).toEqual({});
  });
});
