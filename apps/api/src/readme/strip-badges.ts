import type { ElementContent, Root, RootContent } from 'hast';

/**
 * Drops the badge wall most READMEs open with (§9). It is noise on a tool page — the health
 * signals Keco shows come from Scorecard and the score axes, not from a shields.io image.
 *
 * Deliberately narrow: it removes at most one paragraph, only if that paragraph contains
 * nothing but images, links wrapping images, line breaks and whitespace, and only if it is
 * the first real content — allowing for the title heading READMEs usually put above it. A
 * paragraph carrying one logo and a sentence of prose is left alone.
 *
 * A single bare image is also left alone, even with no prose: a lone `![logo](...)` at the
 * top of a README is almost always the project's own logo, not a badge. A "wall" implies
 * more than one, so stripping requires at least two qualifying elements.
 */
const isBadgeContent = (node: ElementContent): boolean => {
  if (node.type === 'text') return node.value.trim() === '';
  if (node.type !== 'element') return false;
  if (node.tagName === 'img' || node.tagName === 'br') return true;
  if (node.tagName === 'a') return node.children.every(isBadgeContent);
  return false;
};

const isBlank = (node: RootContent): boolean => node.type === 'text' && node.value.trim() === '';

export function stripBadgeParagraph() {
  return (tree: Root): void => {
    for (const [index, node] of tree.children.entries()) {
      if (isBlank(node)) continue;
      if (node.type !== 'element') return;

      // The title, and any subtitle heading above the badges, are skipped over.
      if (/^h[1-6]$/.test(node.tagName)) continue;

      if (node.tagName !== 'p') return;
      if (node.children.length === 0) return;
      if (!node.children.every(isBadgeContent)) return;
      // A paragraph of pure whitespace is not a badge wall, and neither is a single image —
      // a "wall" needs at least two qualifying elements (image or link-wrapping-image).
      const qualifying = node.children.filter(
        (child) => child.type === 'element' && child.tagName !== 'br',
      );
      if (qualifying.length < 2) return;

      tree.children.splice(index, 1);
      return;
    }
  };
}
