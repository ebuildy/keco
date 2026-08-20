import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDocument } from '@keco/core';
import { bootstrapToolFor, setBootstrap } from './bootstrap';

const tool = { full_name: 'ahmetb/kubectx', name: 'kubectx', owner: 'ahmetb' } as unknown as ToolDocument;

afterEach(() => setBootstrap(null));

describe('bootstrapToolFor', () => {
  it('returns the bootstrapped tool when it matches the requested route', () => {
    setBootstrap({ tool });
    expect(bootstrapToolFor('ahmetb/kubectx')).toBe(tool);
  });

  it('refuses a bootstrap left over from a different route', () => {
    // Regression for: navigate /tools/ahmetb/kubectx (prerendered) -> / -> /tools/c/d.
    // ToolPage remounts under c/d but window.__KECO_DATA__ still holds ahmetb/kubectx — a
    // stale accept would render kubectx's <h1> and verified install commands under c/d's URL.
    setBootstrap({ tool });
    expect(bootstrapToolFor('someone-else/other-tool')).toBeNull();
  });

  it('returns null when there is no bootstrap at all', () => {
    expect(bootstrapToolFor('ahmetb/kubectx')).toBeNull();
  });
});
