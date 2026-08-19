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
 *   stripBadgeParagraph                               cosmetic, on already-safe markup
 *   rehype-shiki                                       generates its own markup from safe text
 *
 * Sanitising before rehype-raw would sanitise a tree that does not yet contain the raw HTML,
 * which is the classic way to ship a hole that looks defended. Shiki runs after sanitize on
 * purpose: its `style` and `class` output would be stripped if sanitize ran after it instead,
 * and it only ever emits markup derived from text content that sanitize has already cleared.
 *
 * `rewriteUrls` is not in this shared chain — the base URL differs per repo, so `renderReadme`
 * below `.use()`s it on a thawed copy of the processor, per call, which appends it *after*
 * every plugin listed above, including Shiki. That is harmless (Shiki never emits `img`, `a`
 * or `source`), but it means this is not a strict top-to-bottom diagram of everything that
 * runs — don't reason from it as one.
 */
const schema = {
  ...defaultSchema,
  // READMEs use these constantly for collapsible sections, and neither can execute anything.
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary'],
  // defaultSchema.strip only lists `script`. Everything else it doesn't allowlist gets its
  // *tag* removed but its *text content* kept, which is right for e.g. an unknown element —
  // and wrong for these: their content is meant to be invisible (or interpreted as code), so
  // leaving it as page text renders `<style>.a{color:red}</style>` as the literal string
  // `.a{color:red}`. Escaped, so not XSS — but a visible rendering bug on any README that has
  // one, and `<style>` is common.
  strip: [...(defaultSchema.strip ?? []), 'style', 'title', 'textarea', 'noembed', 'noframes'],
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

/**
 * Pays Shiki's grammar and theme load up front.
 *
 * `processor` is built at module load, but Shiki resolves its languages and themes lazily on
 * the first `.process()` — measured at seconds, not milliseconds, when the machine is busy.
 * Without this the cost lands on whichever unlucky request arrives first after a deploy, on
 * the same libuv threadpool that serves static files (see plugins/static.ts).
 *
 * Idempotent and safe to call concurrently: the promise is memoised, so N callers share one
 * warm-up. Failure is not fatal — the next real render simply pays the cost instead.
 */
let warming: Promise<void> | null = null;

export function warmReadmeRenderer(): Promise<void> {
  warming ??= renderReadme('```bash\nkubectl get pods\n```', 'https://example.invalid/').then(
    () => undefined,
    () => undefined,
  );
  return warming;
}
