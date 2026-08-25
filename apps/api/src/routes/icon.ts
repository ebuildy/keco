import rateLimit from '@fastify/rate-limit';
import { repoKeys } from '@keco/cache/keys';
import { ICON_SIZES, type IconSize } from '@keco/core';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ReadOnlyCache } from '../ports';

/**
 * The icon bytes come from the cache, never from the index — same shape as the README route
 * (AGENTS.md §9): a read of an immutable blob, by key. Never a write, never a list (§2.2, §14).
 *
 * The cache key is built from path parameters, so the vocabulary is pinned to what GitHub can
 * actually issue as an owner or a repository name, and the size to the three the crawler
 * derives. Without both, `..%2f..%2f` reads arbitrary blobs.
 */
const Params = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  size: z.enum(ICON_SIZES.map(String) as [string, ...string[]]),
});

/**
 * Ten times the README route's budget, deliberately. That route runs a markdown pipeline
 * measured at up to 1.4s of blocking CPU per hit; this one reads a few KB by key and writes
 * them to the socket. One tool page pulls one icon, one search page pulls up to twenty, and a
 * reader clicking through the corpus must not trip a limiter over static bytes.
 */
const ICON_RATE_LIMIT = { max: 300, timeWindow: '1 minute' } as const;

export const iconRoutes: FastifyPluginAsync<{ cache: ReadOnlyCache }> = async (app, options) => {
  const { cache } = options;

  await app.register(rateLimit, ICON_RATE_LIMIT);

  /**
   * Scoped to this plugin, same reasoning as the README route's: a rate-limit rejection must
   * reach the caller as 429, and an unexpected crash must not leak a stack trace.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 429) return reply.code(status).send({ error: 'rate_limited', message: error.message });
    request.log.error({ err: error }, 'unhandled error in icon route');
    return reply.code(500).send({ error: 'internal_error' });
  });

  app.get<{ Params: { owner: string; repo: string; size: string } }>(
    '/:owner/:repo/:size.png',
    async (request, reply) => {
      const parsed = Params.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

      const { owner, repo, size } = parsed.data;
      const keys = repoKeys(`${owner}/${repo}`);
      const png = await cache.getBuffer(keys.icon(Number(size) as IconSize));

      // An uncrawled repo is a miss, not an error: most of the corpus has no icon yet.
      if (png === null) return reply.code(404).send({ error: 'not_found' });

      return reply
        .header('content-type', 'image/png')
        // The crawler rewrites these only when the upstream ETag changes, and a day-stale
        // icon is not a claim about anything.
        .header('cache-control', 'public, max-age=86400')
        // The bytes are always a PNG the worker rasterised, never the fetched source. These
        // two make that true for a browser as well as for us.
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        .send(png);
    },
  );
};
