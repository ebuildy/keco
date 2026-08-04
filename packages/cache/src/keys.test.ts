import { describe, expect, it } from 'vitest';
import { discoveryKeys } from './keys';

describe('discoveryKeys', () => {
  it('names the two shared artifacts', () => {
    expect(discoveryKeys.fullList).toBe('discovery/repos-full-list.yaml');
    expect(discoveryKeys.hashes).toBe('discovery/_hashes.json');
    expect(discoveryKeys.state).toBe('discovery/_state.json');
  });

  it('buckets a repo by the first two letters of its owner', () => {
    expect(discoveryKeys.detail('ahmetb/kubectx')).toBe(
      'discovery/a/h/repo-details-ahmetb__kubectx.yaml',
    );
    expect(discoveryKeys.detail('kubernetes-sigs/krew')).toBe(
      'discovery/k/u/repo-details-kubernetes-sigs__krew.yaml',
    );
  });

  it('pads the bucket when the owner is a single character', () => {
    expect(discoveryKeys.detail('x/y')).toBe('discovery/x/_/repo-details-x__y.yaml');
  });

  it('lowercases only the bucket, preserving the real name in the filename', () => {
    expect(discoveryKeys.detail('Foo/Bar')).toBe('discovery/f/o/repo-details-Foo__Bar.yaml');
  });

  it('replaces characters that are unsafe as a directory name', () => {
    // A leading dot would make a hidden directory; a digit is fine.
    expect(discoveryKeys.detail('.github/example')).toBe(
      'discovery/_/g/repo-details-.github__example.yaml',
    );
    expect(discoveryKeys.detail('9gag/thing')).toBe('discovery/9/g/repo-details-9gag__thing.yaml');
  });

  it('rejects anything that is not owner/repo', () => {
    expect(() => discoveryKeys.detail('kubectx')).toThrow(/owner\/repo/);
    expect(() => discoveryKeys.detail('/kubectx')).toThrow(/owner\/repo/);
    expect(() => discoveryKeys.detail('ahmetb/')).toThrow(/owner\/repo/);
  });
});
