import { describe, expect, it } from 'vitest';
import { ICON_SIZES } from '@keco/core';
import { discoveryKeys, repoKeys } from './keys';

describe('discoveryKeys', () => {
  const keys = discoveryKeys('kubernetes');

  it('names the three shared artifacts under the query namespace', () => {
    expect(keys.fullList).toBe('discovery/kubernetes/repos-full-list.yaml');
    expect(keys.hashes).toBe('discovery/kubernetes/_hashes.json');
    expect(keys.state).toBe('discovery/kubernetes/_state.json');
  });

  it('gives a second query its own namespace, so two corpora coexist', () => {
    const istio = discoveryKeys('istio');
    expect(istio.fullList).toBe('discovery/istio/repos-full-list.yaml');
    expect(istio.detail('istio/istio')).toBe('discovery/istio/i/s/repo-details-istio__istio.yaml');
    // Nothing a sweep of "istio" writes can collide with a key of the "kubernetes" sweep.
    expect(istio.fullList).not.toBe(keys.fullList);
    expect(istio.detail('ahmetb/kubectx')).not.toBe(keys.detail('ahmetb/kubectx'));
  });

  it('buckets a repo by the first two letters of its owner', () => {
    expect(keys.detail('ahmetb/kubectx')).toBe(
      'discovery/kubernetes/a/h/repo-details-ahmetb__kubectx.yaml',
    );
    expect(keys.detail('kubernetes-sigs/krew')).toBe(
      'discovery/kubernetes/k/u/repo-details-kubernetes-sigs__krew.yaml',
    );
  });

  it('pads the bucket when the owner is a single character', () => {
    expect(keys.detail('x/y')).toBe('discovery/kubernetes/x/_/repo-details-x__y.yaml');
  });

  it('lowercases only the bucket, preserving the real name in the filename', () => {
    expect(keys.detail('Foo/Bar')).toBe('discovery/kubernetes/f/o/repo-details-Foo__Bar.yaml');
  });

  it('replaces characters that are unsafe as a directory name', () => {
    // A leading dot would make a hidden directory; a digit is fine.
    expect(keys.detail('.github/example')).toBe(
      'discovery/kubernetes/_/g/repo-details-.github__example.yaml',
    );
    expect(keys.detail('9gag/thing')).toBe(
      'discovery/kubernetes/9/g/repo-details-9gag__thing.yaml',
    );
  });

  it('rejects anything that is not owner/repo', () => {
    expect(() => keys.detail('kubectx')).toThrow(/owner\/repo/);
    expect(() => keys.detail('/kubectx')).toThrow(/owner\/repo/);
    expect(() => keys.detail('ahmetb/')).toThrow(/owner\/repo/);
  });

  it('rejects more than one slash', () => {
    expect(() => keys.detail('foo/bar/baz')).toThrow(/owner\/repo/);
    expect(() => keys.detail('a//b')).toThrow(/owner\/repo/);
  });

  describe('query slug', () => {
    const namespaceOf = (query: string): string =>
      discoveryKeys(query).state.slice('discovery/'.length, -'/_state.json'.length);

    it('lowercases and collapses runs of non-alphanumerics to a single dash', () => {
      expect(namespaceOf('Kubernetes Operator')).toBe('kubernetes-operator');
      expect(namespaceOf('topic:kubernetes')).toBe('topic-kubernetes');
      expect(namespaceOf('stars:>5000   kubernetes')).toBe('stars-5000-kubernetes');
    });

    it('trims leading and trailing dashes', () => {
      expect(namespaceOf('  kubernetes  ')).toBe('kubernetes');
      expect(namespaceOf('--kubernetes--')).toBe('kubernetes');
    });

    it('cannot escape the discovery prefix, whatever the query', () => {
      // The whole point of slugifying: a query reaches a cache key, so `..` and `/` must not
      // survive into the path. Each of these produces one flat segment, or nothing at all.
      expect(namespaceOf('a/b')).toBe('a-b');
      expect(namespaceOf('../etc')).toBe('etc');
      expect(namespaceOf('k8s/../../etc/passwd')).toBe('k8s-etc-passwd');
      expect(() => discoveryKeys('..')).toThrow(/alphanumeric/);
      expect(() => discoveryKeys('../..')).toThrow(/alphanumeric/);
      expect(() => discoveryKeys('/')).toThrow(/alphanumeric/);
    });

    it('rejects a query that slugifies to nothing', () => {
      expect(() => discoveryKeys('')).toThrow(/alphanumeric/);
      expect(() => discoveryKeys('   ')).toThrow(/alphanumeric/);
      expect(() => discoveryKeys('---')).toThrow(/alphanumeric/);
      // ASCII-only by design: a non-ASCII keyword has no slug, and failing loudly beats
      // silently sweeping into a directory named after nothing.
      expect(() => discoveryKeys('日本語')).toThrow(/alphanumeric/);
    });

    it('drops non-ASCII characters from an otherwise usable query', () => {
      expect(namespaceOf('kubernetes 日本語')).toBe('kubernetes');
      expect(namespaceOf('café-operator')).toBe('caf-operator');
    });

    it('caps the namespace so a long query cannot blow the filesystem name limit', () => {
      const long = `kubernetes ${'operator '.repeat(60)}`;
      const namespace = namespaceOf(long);
      expect(namespace.length).toBeLessThanOrEqual(100);
      expect(namespace).not.toMatch(/-$/);
      expect(namespace.startsWith('kubernetes-operator-')).toBe(true);
    });

    it('maps two queries that differ only in punctuation onto one namespace', () => {
      // Documented, accepted: the slug is lossy, so `kubernetes operator` and
      // `kubernetes-operator` share a corpus. They are near-identical searches and their union
      // is still a valid candidate list; the escape hatch is a different CACHE_DIR. Pinned as a
      // test so the day it stops being acceptable, the change is deliberate.
      expect(namespaceOf('kubernetes operator')).toBe(namespaceOf('kubernetes-operator'));
    });
  });
});

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
