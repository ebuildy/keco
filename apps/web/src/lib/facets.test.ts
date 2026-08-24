import { describe, expect, it } from 'vitest';
import { COLLAPSE_AFTER, facetGroups } from './facets';

describe('facetGroups', () => {
  it('drops values with no documents behind them', () => {
    const groups = facetGroups({ kind: { operator: 12, cli: 0 } }, {});
    const kind = groups.find((group) => group.familyId === 'kind');

    expect(kind?.options.map((option) => option.id)).toEqual(['operator']);
  });

  it('renders no group at all for a family with no hits', () => {
    expect(facetGroups({ kind: {} }, {})).toEqual([]);
  });

  it('reads install methods from the nested filterable attribute', () => {
    const groups = facetGroups({ 'install_methods.method': { krew: 4 } }, {});

    expect(groups.map((group) => group.familyId)).toContain('install_methods');
  });

  it('marks selected values and counts them', () => {
    const groups = facetGroups({ kind: { operator: 12, cli: 3 } }, { kind: ['operator'] });
    const kind = groups.find((group) => group.familyId === 'kind');

    expect(kind?.options.find((option) => option.id === 'operator')?.selected).toBe(true);
    expect(kind?.options.find((option) => option.id === 'cli')?.selected).toBe(false);
    expect(kind?.selectedCount).toBe(1);
  });

  it('orders values by count, descending', () => {
    const groups = facetGroups({ kind: { cli: 3, operator: 12, controller: 7 } }, {});

    expect(groups[0]?.options.map((option) => option.id)).toEqual(['operator', 'controller', 'cli']);
  });

  it('keeps a selected value visible even when its count would bury it', () => {
    const counts: Record<string, number> = {};
    for (const value of ['cli', 'operator', 'controller', 'helm-chart', 'crd-library', 'dashboard-ui']) {
      counts[value] = 50;
    }
    counts['learning-resource'] = 1;

    const groups = facetGroups({ kind: counts }, { kind: ['learning-resource'] });
    const visible = groups[0]?.options.slice(0, COLLAPSE_AFTER) ?? [];

    expect(visible.some((option) => option.id === 'learning-resource')).toBe(true);
  });
});
