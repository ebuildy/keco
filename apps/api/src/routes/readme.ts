import rateLimit from '@fastify/rate-limit';
import { repoKeys } from '@keco/cache/keys';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { renderReadme } from '../readme/render';
import type { ReadOnlyCache } from '../ports';

/**
 * The README comes from the cache, never from the index (AGENTS.md §9) — and the browser
 * cannot read the cache, so it comes through here. A read of an immutable blob, by key:
 * never a write, never a list (§2.2, §14).
 *
 * The cache key is built from path parameters, so the vocabulary is pinned to what GitHub
 * actually allows in an owner or repo name. Without this, `..%2f..%2f` reads arbitrary blobs.
 */
const Params = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
});

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * §13: validate every external payload at the boundary. `image_base_url` flows straight into
 * the `src`/`href` of every relative image and link on the page, so an unvalidated cast is a
 * base-URL-controlled open redirect / local-file-read waiting to happen: `rewriteUrls`'s
 * try/catch only guards a URL that fails to *parse*, and `new URL(rel, 'file:///etc/')`
 * parses fine. A cached document that fails this falls back to the GitHub-derived default
 * below — exactly what already happens for a genuinely missing `readme.json`.
 */
const ReadmeMetaSchema = z.object({
  path: z.string(),
  branch: z.string(),
  etag: z.string().nullable(),
  /** Relative README image paths break unless rewritten against this (§14). */
  image_base_url: z.string().refine(isHttpsUrl, 'image_base_url must be an https:// URL'),
});

/**
 * A page-load endpoint, not a keystroke one — each hit is one tool-page view, not one
 * search-as-you-type debounce cycle, which is why v1's search route budgets 120/min. This
 * route instead runs the full markdown → HTML pipeline (parse, sanitize, syntax-highlight) on
 * every request: measured at up to 1.4s of single-threaded CPU for a realistic large README,
 * in the same process that also serves search and static assets (AGENTS.md §7, §14). 30/min
 * per IP comfortably covers a human clicking through the corpus while keeping the worst-case
 * CPU exposure an order of magnitude below v1's per-caller budget for a route that costs
 * orders of magnitude more per hit.
 */
const README_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

/**
 * Bounds the CPU (and response size) one request can spend. Measured on author-controlled
 * input: a 91 KB single code fence costs 1.4s of blocking CPU and a 2.2 MB response; 300 KB of
 * links costs 2.1s and 1.4 MB. 64 KB sits comfortably below the point where Shiki's
 * line-by-line highlighting starts to dominate, and covers the overwhelming majority of real
 * READMEs. Anything larger is truncated rather than rendered in full — the response says so
 * via `truncated: true` so the portal can point the reader at GitHub instead of silently
 * showing a partial document.
 */
const MAX_README_BYTES = 64 * 1024;

/**
 * Truncates by bytes, not characters — README content is UTF-8 and a naive character slice
 * can cut a multi-byte character in half. `Buffer#toString('utf8')` replaces an incomplete
 * trailing sequence with U+FFFD instead of throwing, which is exactly the degrade-gracefully
 * behaviour a cosmetic truncation wants.
 */
const truncateUtf8 = (text: string, maxBytes: number): string =>
  Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');

const defaultImageBaseUrl = (fullName: string): string =>
  `https://raw.githubusercontent.com/${fullName}/HEAD/`;

export const readmeRoutes: FastifyPluginAsync<{ cache: ReadOnlyCache }> = async (app, options) => {
  const { cache } = options;

  await app.register(rateLimit, README_RATE_LIMIT);

  /**
   * Scoped to this plugin, same reasoning as v1's handler: a rate-limit rejection must reach
   * the caller as 429, and an unexpected crash here (there is no external dependency to blame
   * it on, unlike v1's Meilisearch) must not leak a stack trace.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 429) return reply.code(status).send({ error: 'rate_limited', message: error.message });
    request.log.error({ err: error }, 'unhandled error in readme route');
    return reply.code(500).send({ error: 'internal_error' });
  });

  app.get<{ Params: { owner: string; repo: string } }>('/:owner/:repo', async (request, reply) => {
    const parsed = Params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const fullName = `${parsed.data.owner}/${parsed.data.repo}`;
    const keys = repoKeys(fullName);

    const [markdown, rawMeta] = await Promise.all([
      cache.getText(keys.readme),
      cache.getJSON<unknown>(keys.readmeMeta),
    ]);

    if (markdown === null) return reply.code(404).send({ error: 'not_found' });

    const parsedMeta = ReadmeMetaSchema.safeParse(rawMeta);
    const imageBaseUrl = parsedMeta.success ? parsedMeta.data.image_base_url : defaultImageBaseUrl(fullName);

    const truncated = Buffer.byteLength(markdown, 'utf8') > MAX_README_BYTES;
    const html = await renderReadme(
      truncated ? truncateUtf8(markdown, MAX_README_BYTES) : markdown,
      imageBaseUrl,
    );

    return reply
      .header('cache-control', 'public, max-age=300')
      .send({ repo: fullName, html, truncated });
  });
};
