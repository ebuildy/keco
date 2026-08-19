import { describe, expect, it } from 'vitest';
import {
  TOOLS_INDEX,
  buildFilters,
  defaultFacets,
  familyAttribute,
  isSortKey,
  paramForFamily,
  selectionFromParams,
  sortSpec,
} from './read';

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

describe('familyAttribute', () => {
  it('nests install_methods, which is an array of objects', () => {
    expect(familyAttribute('install_methods')).toBe('install_methods.method');
  });

  it('leaves every other family as its own attribute', () => {
    expect(familyAttribute('kind')).toBe('kind');
    expect(familyAttribute('governance')).toBe('governance');
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

  it('splits a single repeated URLSearchParams key with comma-joined values', () => {
    const params = new URLSearchParams('domain=security,policy');
    expect(selectionFromParams(params)).toEqual({ domains: ['security', 'policy'] });
  });

  it('reads two repetitions of the same URLSearchParams key', () => {
    const params = new URLSearchParams();
    params.append('domain', 'security');
    params.append('domain', 'policy');
    expect(selectionFromParams(params)).toEqual({ domains: ['security', 'policy'] });
  });
});

describe('paramForFamily', () => {
  it('returns the family’s declared URL parameter', () => {
    expect(paramForFamily('domains')).toBe('domain');
    expect(paramForFamily('install_methods')).toBe('install');
  });
});

describe('sortSpec', () => {
  it('defaults to relevance, which is an empty sort', () => {
    expect(sortSpec()).toEqual([]);
    expect(sortSpec('relevance')).toEqual([]);
  });

  it('maps each key to a Meilisearch sort expression', () => {
    expect(sortSpec('stars')).toEqual(['stars:desc']);
    expect(sortSpec('score')).toEqual(['score.total:desc']);
    expect(sortSpec('momentum')).toEqual(['score.momentum:desc']);
    expect(sortSpec('recent')).toEqual(['pushed_at:desc']);
  });
});

describe('isSortKey', () => {
  it('accepts the five keys and rejects anything else', () => {
    // This is what stops a hand-edited ?sort= reaching Meilisearch as an unknown expression.
    expect(isSortKey('momentum')).toBe(true);
    expect(isSortKey('stars:desc')).toBe(false);
    expect(isSortKey('')).toBe(false);
  });
});

describe('TOOLS_INDEX', () => {
  it('is the public alias both the portal and the API read', () => {
    expect(TOOLS_INDEX).toBe('tools');
  });
});
