import { describe, expect, it } from 'vitest';
import { SEED_NAMES, SEEDS, resolveSeeds } from './index';

describe('SEEDS', () => {
  it('registers all five seeds AGENTS.md §4.2 names', () => {
    expect(SEED_NAMES).toEqual(['cncf', 'krew', 'artifacthub', 'operatorhub', 'awesome']);
  });

  it('gives every adapter a name matching its registry key', () => {
    for (const [key, adapter] of Object.entries(SEEDS)) {
      expect(adapter.name).toBe(key);
    }
  });

  it('lists cncf and krew first — the CLI defaults, and the highest signal', () => {
    expect(SEED_NAMES.slice(0, 2)).toEqual(['cncf', 'krew']);
  });
});

describe('resolveSeeds', () => {
  it('resolves names in the order given, so --seed sets crawl priority', () => {
    expect(resolveSeeds(['krew', 'cncf']).map((s) => s.name)).toEqual(['krew', 'cncf']);
  });

  it('deduplicates a repeated name', () => {
    expect(resolveSeeds(['cncf', 'cncf']).map((s) => s.name)).toEqual(['cncf']);
  });

  it('rejects an unknown seed by name, listing what is available', () => {
    expect(() => resolveSeeds(['cncf', 'nope'])).toThrow(/nope/);
    expect(() => resolveSeeds(['nope'])).toThrow(/cncf, krew, artifacthub, operatorhub, awesome/);
  });

  it('accepts an empty list — a --repo run seeds from nothing', () => {
    expect(resolveSeeds([])).toEqual([]);
  });
});
