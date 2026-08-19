import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';

/**
 * Relative README image and link paths break outside GitHub unless rewritten against the
 * repo's `image_base_url` (AGENTS.md §14 — test with kubernetes/kubectl).
 *
 * Runs after rehype-sanitize, so by the time this sees an attribute the dangerous schemes are
 * already gone. It only touches values that are relative: an absolute URL, a protocol-relative
 * one and a fragment are all left exactly as the author wrote them.
 */
const URL_ATTRIBUTE: Record<string, string> = { img: 'src', a: 'href', source: 'srcset' };

/** Anything with a scheme, protocol-relative, or a pure fragment is already resolvable. */
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

export function rewriteUrls(options: { base: string }) {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      const attribute = URL_ATTRIBUTE[node.tagName];
      if (!attribute) return;

      const value = node.properties[attribute];
      if (typeof value !== 'string' || value === '' || ABSOLUTE.test(value)) return;

      try {
        node.properties[attribute] = new URL(value, options.base).toString();
      } catch {
        // An unresolvable path is left as-is rather than dropping the element: a broken image
        // is a cosmetic bug, a thrown render is a 500 on a page that was otherwise fine.
      }
    });
  };
}
