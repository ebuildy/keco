import { describe, expect, it } from 'vitest';
import { iconUrl, monogram } from './icon';

describe('iconUrl', () => {
  it('points at the API route for the requested size', () => {
    expect(iconUrl('derailed/k9s', 32)).toBe('/api/icon/derailed/k9s/32.png');
    expect(iconUrl('derailed/k9s', 160)).toBe('/api/icon/derailed/k9s/160.png');
  });
});

describe('monogram', () => {
  it('uses the first letter of the repository name, uppercased', () => {
    expect(monogram('derailed/k9s').letter).toBe('K');
    expect(monogram('argoproj/argo-cd').letter).toBe('A');
  });

  // The tile must not change colour between a result card and the tool page, or between two
  // visits — it reads as a stable stand-in for a logo, not as a state.
  it('derives a stable hue from the full name', () => {
    expect(monogram('derailed/k9s').hue).toBe(monogram('derailed/k9s').hue);
    expect(monogram('derailed/k9s').hue).not.toBe(monogram('helm/helm').hue);
  });

  it('keeps the hue in range', () => {
    for (const name of ['a/b', 'derailed/k9s', 'kubernetes-sigs/kustomize', 'x/' + 'y'.repeat(80)]) {
      const { hue } = monogram(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('falls back to a placeholder rather than throwing on a nameless entry', () => {
    expect(monogram('').letter).toBe('?');
  });

  it('skips a leading non-letter so the tile is never a dash', () => {
    expect(monogram('foo/-bar').letter).toBe('B');
    expect(monogram('foo/2048').letter).toBe('2');
  });
});
