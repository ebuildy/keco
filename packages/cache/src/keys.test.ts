import { describe, expect, it } from 'vitest';
import { ICON_SIZES } from '@keco/core';
import { repoKeys } from './keys';

describe('repoKeys icons', () => {
  const keys = repoKeys('derailed/k9s');

  // No extension: discovering one would mean listing the prefix to see what is there, and
  // §14 forbids listing the cache. The real content type lives in icon.json.
  it('stores the fetched bytes at one fixed, extension-less key', () => {
    expect(keys.iconSource).toBe('repos/derailed/k9s/icon.src');
  });

  it('names one derived PNG per rendered size', () => {
    expect(keys.icon(32)).toBe('repos/derailed/k9s/icon-32.png');
    expect(keys.icon(64)).toBe('repos/derailed/k9s/icon-64.png');
    expect(keys.icon(160)).toBe('repos/derailed/k9s/icon-160.png');
  });

  it('keeps the metadata beside them', () => {
    expect(keys.iconMeta).toBe('repos/derailed/k9s/icon.json');
  });

  it('exports the sizes it derives, so no caller hardcodes the list', () => {
    // Declared in @keco/core so the portal can read it too; pinned here because `icon(size)`
    // is the key builder that has to stay in step with it.
    expect(ICON_SIZES).toEqual([32, 64, 160]);
  });
});
