import { describe, expect, it } from 'vitest';
import { toReadmeArtifacts } from './readme';

const encode = (markdown: string): string => Buffer.from(markdown, 'utf8').toString('base64');

describe('toReadmeArtifacts', () => {
  it('decodes a root README and derives a branch-rooted image base', () => {
    const result = toReadmeArtifacts(
      { path: 'README.md', content: encode('# Argo CD\n'), encoding: 'base64' },
      { repo: 'argoproj/argo-cd', branch: 'master', etag: 'W/"abc"' },
    );

    expect(result).toEqual({
      markdown: '# Argo CD\n',
      meta: {
        path: 'README.md',
        branch: 'master',
        etag: 'W/"abc"',
        image_base_url: 'https://raw.githubusercontent.com/argoproj/argo-cd/master/',
      },
    });
  });

  it('bases a nested README on its own directory', () => {
    const result = toReadmeArtifacts(
      { path: 'docs/README.md', content: encode('hi'), encoding: 'base64' },
      { repo: 'o/r', branch: 'main', etag: null },
    );
    expect(result?.meta.image_base_url).toBe('https://raw.githubusercontent.com/o/r/main/docs/');
  });

  it('always ends the image base with a slash', () => {
    for (const path of ['README.md', 'docs/README.md', 'a/b/c/README.md']) {
      const result = toReadmeArtifacts(
        { path, content: encode('x'), encoding: 'base64' },
        { repo: 'o/r', branch: 'main', etag: null },
      );
      expect(result?.meta.image_base_url.endsWith('/')).toBe(true);
      expect(result?.meta.image_base_url.startsWith('https://')).toBe(true);
    }
  });

  it('decodes base64 that GitHub wrapped in newlines', () => {
    const wrapped = encode('# Title\n').replace(/(.{4})/g, '$1\n');
    const result = toReadmeArtifacts(
      { path: 'README.md', content: wrapped, encoding: 'base64' },
      { repo: 'o/r', branch: 'main', etag: null },
    );
    expect(result?.markdown).toBe('# Title\n');
  });

  it('preserves UTF-8 beyond ASCII', () => {
    const result = toReadmeArtifacts(
      { path: 'README.md', content: encode('# 日本語 — café 🎉'), encoding: 'base64' },
      { repo: 'o/r', branch: 'main', etag: null },
    );
    expect(result?.markdown).toBe('# 日本語 — café 🎉');
  });

  it('returns null when there is no content', () => {
    expect(toReadmeArtifacts({ path: 'README.md' }, { repo: 'o/r', branch: 'main', etag: null })).toBeNull();
  });

  it('returns null for an encoding it cannot decode', () => {
    expect(
      toReadmeArtifacts(
        { path: 'README.md', content: 'x', encoding: 'none' },
        { repo: 'o/r', branch: 'main', etag: null },
      ),
    ).toBeNull();
  });

  it('returns null when the path is missing', () => {
    expect(
      toReadmeArtifacts({ content: encode('x'), encoding: 'base64' }, { repo: 'o/r', branch: 'main', etag: null }),
    ).toBeNull();
  });
});
