import type { Element, Root } from 'hast';
import { describe, expect, it } from 'vitest';
import { rewriteUrls } from './rewrite-urls';

const BASE = 'https://raw.githubusercontent.com/kubernetes/kubectl/HEAD/';

const sourceTree = (srcSet: string): Root => ({
  type: 'root',
  children: [{ type: 'element', tagName: 'source', properties: { srcSet }, children: [] }],
});

const srcSetOf = (tree: Root): unknown => (tree.children[0] as Element).properties.srcSet;

describe('rewriteUrls — srcset (a candidate list, not one URL)', () => {
  it('rewrites a single relative candidate with no descriptor', () => {
    const tree = sourceTree('docs/logo-dark.png');
    rewriteUrls({ base: BASE })(tree);
    expect(srcSetOf(tree)).toBe(`${BASE}docs/logo-dark.png`);
  });

  it('rewrites multiple candidates carrying density (x) descriptors', () => {
    const tree = sourceTree('a.png 1x, b.png 2x');
    rewriteUrls({ base: BASE })(tree);
    expect(srcSetOf(tree)).toBe(`${BASE}a.png 1x, ${BASE}b.png 2x`);
  });

  it('rewrites multiple candidates carrying width (w) descriptors', () => {
    const tree = sourceTree('a.png 480w, b.png 800w');
    rewriteUrls({ base: BASE })(tree);
    expect(srcSetOf(tree)).toBe(`${BASE}a.png 480w, ${BASE}b.png 800w`);
  });

  it('rewrites relative candidates but leaves an absolute one alone', () => {
    const tree = sourceTree('https://example.com/a.png 1x, docs/b.png 2x');
    rewriteUrls({ base: BASE })(tree);
    expect(srcSetOf(tree)).toBe(`https://example.com/a.png 1x, ${BASE}docs/b.png 2x`);
  });

  it('tolerates surrounding whitespace around candidates and descriptors', () => {
    const tree = sourceTree('  a.png 1x  ,   b.png 2x  ');
    rewriteUrls({ base: BASE })(tree);
    expect(srcSetOf(tree)).toBe(`${BASE}a.png 1x, ${BASE}b.png 2x`);
  });
});
