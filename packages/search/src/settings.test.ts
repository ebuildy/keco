import { TAXONOMY, familyAttribute } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { TOOLS_SETTINGS } from './settings';

describe('TOOLS_SETTINGS', () => {
  it('makes every taxonomy family filterable', () => {
    for (const family of TAXONOMY) {
      expect(TOOLS_SETTINGS.filterableAttributes).toContain(familyAttribute(family.id));
    }
  });

  it('nests the install method attribute', () => {
    expect(familyAttribute('install_methods')).toBe('install_methods.method');
    expect(familyAttribute('kind')).toBe('kind');
  });

  it('searches github_topics, not topics', () => {
    expect(TOOLS_SETTINGS.searchableAttributes).toContain('github_topics');
    expect(TOOLS_SETTINGS.searchableAttributes).not.toContain('topics');
  });
});
