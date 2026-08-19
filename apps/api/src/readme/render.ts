import rehypeShiki from '@shikijs/rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { rewriteUrls } from './rewrite-urls';
import { stripBadgeParagraph } from './strip-badges';

/**
 * Cached README markdown → sanitised HTML (AGENTS.md §9). Pure: the caller reads the bytes
 * out of the cache and passes them in, so this is testable on fixture strings.
 *
 * Plugin order is the security property, and it is not rearrangeable:
 *
 *   remark-rehype(allowDangerousHtml) → rehype-raw   parses the inline HTML READMEs contain
 *   rehype-sanitize                                  removes it if it is dangerous
 *   stripBadgeParagraph, rewriteUrls                 cosmetics, on already-safe markup
 *   rehype-shiki                                      generates its own markup from safe text
 *
 * Sanitising before rehype-raw would sanitise a tree that does not yet contain the raw HTML,
 * which is the classic way to ship a hole that looks defended. Shiki runs last on purpose:
 * its `style` and `class` output would be stripped if sanitize came after it, and it only
 * ever emits markup derived from text content that sanitize has already cleared.
 */
const schema = {
  ...defaultSchema,
  // READMEs use these constantly for collapsible sections, and neither can execute anything.
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary'],
};

/**
 * Built once. Shiki loads grammars and themes on first use, which is slow enough that doing
 * it per request would be visible; unified processors are safe to reuse across calls.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(stripBadgeParagraph)
  .use(rehypeShiki, { themes: { light: 'github-light', dark: 'github-dark' } })
  .use(rehypeStringify)
  .freeze();

export async function renderReadme(markdown: string, imageBaseUrl: string): Promise<string> {
  const file = await processor().use(rewriteUrls, { base: imageBaseUrl }).process(markdown);
  return String(file);
}
