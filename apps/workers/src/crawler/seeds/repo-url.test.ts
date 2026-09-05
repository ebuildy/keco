// apps/workers/src/crawler/seeds/repo-url.test.ts
import { describe, expect, it } from 'vitest';
import { RepoRef } from '@keco/core';
import { repoFromUrl } from './repo-url';

describe('repoFromUrl', () => {
  it('extracts owner/repo from a canonical URL', () => {
    expect(repoFromUrl('https://github.com/argoproj/argo-cd')).toBe('argoproj/argo-cd');
  });

  it('ignores a deep path', () => {
    expect(repoFromUrl('https://github.com/argoproj/argo-cd/tree/master/docs')).toBe('argoproj/argo-cd');
  });

  it('strips a trailing .git', () => {
    expect(repoFromUrl('https://github.com/argoproj/argo-cd.git')).toBe('argoproj/argo-cd');
  });

  it('strips a trailing slash', () => {
    expect(repoFromUrl('https://github.com/argoproj/argo-cd/')).toBe('argoproj/argo-cd');
  });

  it('accepts the www host', () => {
    expect(repoFromUrl('https://www.github.com/helm/helm')).toBe('helm/helm');
  });

  it('accepts http as well as https', () => {
    expect(repoFromUrl('http://github.com/helm/helm')).toBe('helm/helm');
  });

  it('rejects a non-GitHub host', () => {
    expect(repoFromUrl('https://gitlab.com/o/r')).toBeNull();
    expect(repoFromUrl('https://raw.githubusercontent.com/o/r/main/x')).toBeNull();
  });

  it('rejects a host that merely ends in github.com', () => {
    expect(repoFromUrl('https://evil-github.com/o/r')).toBeNull();
  });

  it('rejects GitHub paths that are not repos', () => {
    for (const url of [
      'https://github.com/sponsors/someone',
      'https://github.com/orgs/kubernetes',
      'https://github.com/topics/kubernetes',
      'https://github.com/features/actions',
      'https://github.com/marketplace/x',
      'https://github.com/search?q=k8s',
    ]) {
      expect(repoFromUrl(url)).toBeNull();
    }
  });

  it('rejects a bare owner with no repo', () => {
    expect(repoFromUrl('https://github.com/kubernetes')).toBeNull();
  });

  it('rejects junk', () => {
    expect(repoFromUrl('not a url')).toBeNull();
    expect(repoFromUrl('')).toBeNull();
    expect(repoFromUrl(null)).toBeNull();
    expect(repoFromUrl(undefined)).toBeNull();
  });

  it('only ever returns something RepoRef accepts', () => {
    for (const url of [
      'https://github.com/argoproj/argo-cd',
      'https://github.com/o/r.js',
      'https://github.com/o/r_1-2.git',
    ]) {
      const ref = repoFromUrl(url);
      expect(ref).not.toBeNull();
      expect(() => RepoRef.parse(ref)).not.toThrow();
    }
  });
});
