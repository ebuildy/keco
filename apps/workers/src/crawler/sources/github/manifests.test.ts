import { describe, expect, it } from 'vitest';
import { selectManifests, MANIFEST_FILES, MAX_MANIFESTS } from './manifests';

describe('selectManifests', () => {
  it('selects root manifests it recognises', () => {
    expect(selectManifests(['go.mod', 'main.go', 'README.md', 'Cargo.toml'])).toEqual([
      'go.mod',
      'Cargo.toml',
    ]);
  });

  it('ignores a recognised name in a subdirectory', () => {
    expect(selectManifests(['vendor/go.mod', 'examples/package.json'])).toEqual([]);
  });

  it('falls back to the shallowest Chart.yaml when the root has none', () => {
    expect(selectManifests(['charts/nginx/Chart.yaml', 'deep/a/b/c/Chart.yaml'])).toEqual([
      'charts/nginx/Chart.yaml',
    ]);
  });

  it('breaks a depth tie alphabetically so the result is deterministic', () => {
    expect(selectManifests(['charts/zeta/Chart.yaml', 'charts/alpha/Chart.yaml'])).toEqual([
      'charts/alpha/Chart.yaml',
    ]);
  });

  it('prefers the root Chart.yaml over a nested one', () => {
    expect(selectManifests(['Chart.yaml', 'charts/nginx/Chart.yaml'])).toEqual(['Chart.yaml']);
  });

  it('returns paths in the declared order, not tree order', () => {
    // MANIFEST_FILES order is go.mod, Chart.yaml, package.json, Cargo.toml, pyproject.toml.
    expect(selectManifests(['Cargo.toml', 'package.json', 'go.mod'])).toEqual([
      'go.mod',
      'package.json',
      'Cargo.toml',
    ]);
  });

  it('never returns more than MAX_MANIFESTS', () => {
    const everything = [...MANIFEST_FILES, 'charts/a/Chart.yaml'];
    expect(selectManifests(everything).length).toBeLessThanOrEqual(MAX_MANIFESTS);
  });

  it('handles an empty tree', () => {
    expect(selectManifests([])).toEqual([]);
  });
});
