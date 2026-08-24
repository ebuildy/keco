import { describe, expect, it } from 'vitest';
import { chipRows, topCategories } from './topics';

const distribution = {
  kind: { cli: 412, operator: 288, controller: 190 },
  domains: { security: 340, observability: 297 },
  openness: { 'fully-open': 900, unknown: 4000 },
};

describe('chipRows', () => {
  it('builds one row per family that has counts', () => {
    const rows = chipRows(distribution);
    expect(rows.map((row) => row.familyId)).toEqual(['kind', 'domains', 'openness']);
  });

  it('labels rows and chips from the taxonomy', () => {
    const [kind] = chipRows(distribution);
    expect(kind!.label).toBe('Kind');
    expect(kind!.chips[0]!.label).toBe('CLI');
    expect(kind!.chips[0]!.description).toContain('command-line');
  });

  it('sorts chips by count, descending', () => {
    const [kind] = chipRows(distribution);
    expect(kind!.chips.map((chip) => chip.id)).toEqual(['cli', 'operator', 'controller']);
  });

  it('links each chip to search using the family parameter', () => {
    const [, domains] = chipRows(distribution);
    expect(domains!.chips[0]!.href).toBe('/search?domain=security');
  });

  it('never renders a hidden value', () => {
    const openness = chipRows(distribution).find((row) => row.familyId === 'openness');
    expect(openness!.chips.map((chip) => chip.id)).toEqual(['fully-open']);
  });

  it('omits a family with no counts rather than rendering an empty row', () => {
    expect(chipRows({ kind: {} }).length).toBe(0);
  });

  it('returns nothing for an empty index', () => {
    expect(chipRows({})).toEqual([]);
  });

  it('caps a row and offers a more link past the cap', () => {
    const rows = chipRows(distribution, 2);
    expect(rows[0]!.chips).toHaveLength(2);
    expect(rows[0]!.moreHref).toBe('/search');
  });

  it('offers no more link when everything fits', () => {
    expect(chipRows(distribution, 12)[0]!.moreHref).toBeNull();
  });

  it('reads the nested install method distribution', () => {
    const rows = chipRows({ 'install_methods.method': { krew: 180, helm: 300 } });
    expect(rows[0]!.familyId).toBe('install_methods');
    expect(rows[0]!.chips.map((chip) => chip.id)).toEqual(['helm', 'krew']);
    expect(rows[0]!.chips[0]!.href).toBe('/search?install=helm');
  });
});

describe('topCategories', () => {
  it('ranks across kind and domains together, highest count first', () => {
    const chips = topCategories({
      kind: { operator: 12, cli: 40 },
      domains: { networking: 25 },
    });

    expect(chips.map((chip) => chip.label)).toEqual(['CLI', 'Networking', 'Operator']);
    expect(chips[0]?.count).toBe(40);
  });

  it('links each chip by its family declared param, not its family id', () => {
    // `domains` is selected by `?domain=`, singular. Hardcoding the id here is the bug this
    // asserts against.
    const chips = topCategories({ domains: { networking: 3 } });

    expect(chips[0]?.href).toBe('/search?domain=networking');
  });

  it('drops values with no documents behind them', () => {
    const chips = topCategories({ kind: { operator: 5, cli: 0 } });

    expect(chips.map((chip) => chip.label)).toEqual(['Operator']);
  });

  it('returns nothing for an empty index, so the caller renders no row', () => {
    expect(topCategories({})).toEqual([]);
  });

  it('caps at the limit', () => {
    const kind: Record<string, number> = {};
    for (const [index, value] of ['cli', 'operator', 'controller', 'helm-chart'].entries()) {
      kind[value] = 100 - index;
    }

    expect(topCategories({ kind }, 2)).toHaveLength(2);
  });

  it('ignores hidden values such as `unknown`, which never reach the UI (§6)', () => {
    // `values()` filters hidden entries, so an `unknown` with a real count must not surface.
    const chips = topCategories({ kind: { operator: 5 }, domains: { unknown: 9999 } });

    expect(chips.every((chip) => chip.label.toLowerCase() !== 'unknown')).toBe(true);
  });
});
