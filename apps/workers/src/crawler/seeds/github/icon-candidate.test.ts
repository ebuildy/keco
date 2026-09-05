import { describe, expect, it } from 'vitest';
import { resolveIconCandidate, type IconInputs } from './icon-candidate';

const inputs = (over: Partial<IconInputs> = {}): IconInputs => ({
  repo: 'acme/widget',
  defaultBranch: 'main',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42',
  treePaths: [],
  readme: '',
  ...over,
});

const RAW = 'https://raw.githubusercontent.com/acme/widget/main';

describe('resolveIconCandidate — tier 1, the file tree', () => {
  it('prefers .github/logo.svg over everything else', () => {
    const found = resolveIconCandidate(
      inputs({ treePaths: ['README.md', 'assets/logo.png', '.github/logo.svg'] }),
    );
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/.github/logo.svg` });
  });

  it('walks the tiers in order when the earlier ones are absent', () => {
    const found = resolveIconCandidate(inputs({ treePaths: ['docs/images/logo.png'] }));
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/docs/images/logo.png` });
  });

  // cert-manager keeps its mark at logo/logo.svg. Before this entry existed it fell through
  // to the org avatar, which is a weaker claim about a project that clearly has its own logo.
  it('finds a mark in a dedicated logo/ directory', () => {
    const found = resolveIconCandidate(inputs({ treePaths: ['logo/logo.svg', 'README.md'] }));
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/logo/logo.svg` });
  });

  it('still prefers .github/ over a logo/ directory', () => {
    const found = resolveIconCandidate(
      inputs({ treePaths: ['logo/logo.svg', '.github/logo.png'] }),
    );
    expect(found?.url).toBe(`${RAW}/.github/logo.png`);
  });

  // Argo CD uses docs/assets, Trivy uses docs/imgs. docs/images alone missed both.
  it.each([
    ['docs/imgs/logo.png', 'aquasecurity/trivy'],
    ['docs/assets/logo.png', 'argoproj/argo-cd'],
  ])('finds a mark at %s, as %s ships it', (path) => {
    const found = resolveIconCandidate(inputs({ treePaths: [path, 'README.md'] }));
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/${path}` });
  });

  it('ignores a logo in a directory it does not recognise', () => {
    const found = resolveIconCandidate(inputs({ treePaths: ['vendor/other/logo.png'] }));
    expect(found?.source).toBe('owner-avatar');
  });

  it('ignores a file whose extension is not an image it can rasterise', () => {
    const found = resolveIconCandidate(inputs({ treePaths: ['logo.ico'] }));
    expect(found?.source).toBe('owner-avatar');
  });

  it('resolves against the default branch, not HEAD', () => {
    const found = resolveIconCandidate(
      inputs({ defaultBranch: 'master', treePaths: ['logo.png'] }),
    );
    expect(found?.url).toBe('https://raw.githubusercontent.com/acme/widget/master/logo.png');
  });
});

describe('resolveIconCandidate — tier 2, the README', () => {
  it('takes a relative image and resolves it against the branch', () => {
    const found = resolveIconCandidate(inputs({ readme: '# Widget\n\n![logo](docs/mark.png)\n' }));
    expect(found).toEqual({ source: 'repo-logo', url: `${RAW}/docs/mark.png` });
  });

  it('accepts an absolute GitHub user-content URL', () => {
    const url = 'https://user-images.githubusercontent.com/1/mark.png';
    const found = resolveIconCandidate(inputs({ readme: `![logo](${url})` }));
    expect(found).toEqual({ source: 'repo-logo', url });
  });

  // README markdown is untrusted input written by 30k strangers, and a candidate is a URL
  // this system would otherwise fetch on their instruction. §8 rules homepage favicons out
  // for exactly this reason; tier 2 must not quietly reopen it.
  it('refuses an image on any other host', () => {
    const found = resolveIconCandidate(
      inputs({ readme: '![logo](https://evil.example.com/mark.png)' }),
    );
    expect(found?.source).toBe('owner-avatar');
  });

  it('refuses a non-http scheme', () => {
    const found = resolveIconCandidate(inputs({ readme: '![logo](file:///etc/passwd)' }));
    expect(found?.source).toBe('owner-avatar');
  });

  it('skips known badge hosts', () => {
    const readme = '![build](https://img.shields.io/badge/build-passing.svg)\n\n![logo](m.png)';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/m.png`);
  });

  it('skips a workflow status badge served from github.com', () => {
    const badge = 'https://github.com/acme/widget/actions/workflows/ci.yml/badge.svg';
    const readme = `![ci](${badge})\n\n![logo](m.png)`;
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/m.png`);
  });

  // Three images in one paragraph is a badge row, whatever the hosts are.
  it('skips a badge row and takes the image after it', () => {
    const readme = '![a](a.png) ![b](b.png) ![c](c.png)\n\n![logo](mark.png)';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/mark.png`);
  });

  it('takes two images in one paragraph, which is not a badge row', () => {
    const readme = '![logo](mark.png) ![sub](sub.png)';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/mark.png`);
  });

  it('reads an HTML <img> too — plenty of READMEs centre their logo that way', () => {
    const readme = '<p align="center"><img src="docs/mark.png" width="200"></p>';
    expect(resolveIconCandidate(inputs({ readme }))?.url).toBe(`${RAW}/docs/mark.png`);
  });
});

describe('resolveIconCandidate — tier 3, the owner avatar', () => {
  it('falls back to the avatar at a size that never upscales the 160px derivative', () => {
    expect(resolveIconCandidate(inputs())).toEqual({
      source: 'owner-avatar',
      url: 'https://avatars.githubusercontent.com/u/42?s=460',
    });
  });

  it('preserves an existing query string on the avatar URL', () => {
    const found = resolveIconCandidate(
      inputs({ avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4' }),
    );
    expect(found?.url).toBe('https://avatars.githubusercontent.com/u/42?v=4&s=460');
  });

  it('returns null when there is no avatar either', () => {
    expect(resolveIconCandidate(inputs({ avatarUrl: null }))).toBeNull();
  });
});
