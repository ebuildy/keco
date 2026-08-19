import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';

/**
 * Relative README image and link paths break outside GitHub unless rewritten against the
 * repo's `image_base_url` (AGENTS.md §14 — test with kubernetes/kubectl).
 *
 * Runs after rehype-sanitize, so by the time this sees an attribute the dangerous schemes are
 * already gone. It only touches values that are relative: an absolute URL, a protocol-relative
 * one and a fragment are all left exactly as the author wrote them.
 *
 * hast names the `srcset` HTML attribute `srcSet` (property-information's camelCase mapping,
 * not the lowercase DOM attribute name a naive lookup expects) — a lookup keyed on the literal
 * string `srcset` is always `undefined` and silently does nothing, which is how
 * `<picture><source srcset="...">` — the standard modern-README dark-mode-logo pattern — kept
 * 404ing while the sibling `<img>` right next to it worked.
 */
const URL_ATTRIBUTE: Record<string, string> = { img: 'src', a: 'href', source: 'srcSet' };

/** Anything with a scheme, protocol-relative, or a pure fragment is already resolvable. */
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

const rewriteIfRelative = (value: string, base: string): string => {
  if (value === '' || ABSOLUTE.test(value)) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    // An unresolvable path is left as-is rather than dropping the element: a broken image
    // is a cosmetic bug, a thrown render is a 500 on a page that was otherwise fine.
    return value;
  }
};

/**
 * `srcset` is not one URL — it is a comma-separated list of image candidates, each an
 * optional URL followed by a width (`480w`) or pixel-density (`2x`) descriptor, e.g.
 * `a.png 1x, b.png 2x`. A bare `new URL()` on the whole string is wrong twice over: it folds
 * the descriptor into the path, and it only ever looks at the first candidate.
 *
 * Splitting on `,` is exactly what a browser's own srcset parser does: the spec forbids an
 * unescaped comma inside a candidate URL, so a literal `,` always terminates one candidate and
 * starts the next. Each piece is trimmed (surrounding whitespace between candidates and around
 * descriptors is legal), the URL portion is rewritten if relative, and the descriptor — if any
 * — is reattached unchanged.
 */
const rewriteSrcset = (value: string, base: string): string =>
  value
    .split(',')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .map((candidate) => {
      const spaceIndex = candidate.search(/\s/);
      const url = spaceIndex === -1 ? candidate : candidate.slice(0, spaceIndex);
      const descriptor = spaceIndex === -1 ? '' : candidate.slice(spaceIndex).trim();
      const rewritten = rewriteIfRelative(url, base);
      return descriptor ? `${rewritten} ${descriptor}` : rewritten;
    })
    .join(', ');

export function rewriteUrls(options: { base: string }) {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      const attribute = URL_ATTRIBUTE[node.tagName];
      if (!attribute) return;

      const value = node.properties[attribute];
      if (typeof value !== 'string' || value === '') return;

      node.properties[attribute] =
        attribute === 'srcSet' ? rewriteSrcset(value, options.base) : rewriteIfRelative(value, options.base);
    });
  };
}
