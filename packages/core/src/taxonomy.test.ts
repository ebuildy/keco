import { describe, expect, it } from 'vitest';
import {
  DOMAINS,
  Domains,
  FALLBACK_KIND,
  INSTALL_METHODS,
  KINDS,
  TAXONOMY,
  aliasesFor,
  allValues,
  facetableFamilies,
  family,
  familyByParam,
  isDomain,
  isInstallMethod,
  isKind,
  isValue,
  listSchema,
  paramFor,
  valueSchema,
  values,
} from './taxonomy';

/** These run against the real committed packages/core/taxonomy.yaml. */
describe('taxonomy accessors', () => {
  it('loads all eight families in declared order', () => {
    expect(TAXONOMY.map((f) => f.id)).toEqual([
      'kind',
      'domains',
      'runtime',
      'install_methods',
      'license_class',
      'openness',
      'maturity',
      'governance',
    ]);
  });

  it('throws on an unknown family', () => {
    expect(() => family('nope')).toThrow(/unknown family: nope/);
  });

  it('excludes hidden values from values() but not allValues()', () => {
    expect(values('openness').map((v) => v.id)).not.toContain('unknown');
    expect(allValues('openness').map((v) => v.id)).toContain('unknown');
  });

  it('maps aliases case-insensitively to value ids', () => {
    const domains = aliasesFor('domains');
    expect(domains.get('prometheus')).toBe('observability');
    expect(domains.get('Prometheus')).toBeUndefined(); // keys are lowercased; look up lowercased
    expect(aliasesFor('license_class').get('apache-2.0')).toBe('permissive');
  });

  it('distinguishes BSL-1.0 from BUSL-1.1', () => {
    const licences = aliasesFor('license_class');
    expect(licences.get('bsl-1.0')).toBe('permissive');
    expect(licences.get('busl-1.1')).toBe('source-available');
  });

  it('resolves params in both directions', () => {
    expect(paramFor('domains')).toBe('domain');
    expect(paramFor('install_methods')).toBe('install');
    expect(familyByParam('domain')?.id).toBe('domains');
    expect(familyByParam('nope')).toBeNull();
  });

  it('lists facetable families', () => {
    expect(facetableFamilies()).toContain('kind');
    expect(facetableFamilies()).toContain('governance');
  });

  it('keeps the legacy list exports working', () => {
    expect(KINDS).toContain('kubectl-plugin');
    expect(DOMAINS).toContain('database');
    expect(INSTALL_METHODS).toContain('krew');
    expect(isKind('operator')).toBe(true);
    expect(isKind('nope')).toBe(false);
    expect(isDomain('secrets')).toBe(true);
    expect(isInstallMethod('helm')).toBe(true);
    expect(isKind(FALLBACK_KIND)).toBe(true);
  });

  it('validates a single value with valueSchema', () => {
    expect(valueSchema('kind').parse('cli')).toBe('cli');
    expect(() => valueSchema('kind').parse('nope')).toThrow();
    // Hidden values are still valid data — they are only hidden from the UI.
    expect(valueSchema('openness').parse('unknown')).toBe('unknown');
  });

  it('applies the family min and max in listSchema', () => {
    expect(Domains.parse(['security'])).toEqual(['security']);
    expect(() => Domains.parse([])).toThrow();
    expect(() => Domains.parse(['security', 'policy', 'storage', 'cost'])).toThrow();
    // install_methods declares neither min nor max: unbounded, and empty is legal.
    expect(listSchema('install_methods').parse([])).toEqual([]);
  });
});
