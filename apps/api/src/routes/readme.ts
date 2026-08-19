import { repoKeys } from '@keco/cache/keys';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { renderReadme } from '../readme/render';
import type { ReadOnlyCache } from '../ports';

/**
 * The README comes from the cache, never from the index (AGENTS.md §9) — and the browser
 * cannot read the cache, so it comes through here. A read of an immutable blob, by key:
 * never a write, never a list (§2.2, §14).
 */
type ReadmeMeta = {
  path: string;
  branch: string;
  etag: string | null;
  /** Relative README image paths break unless rewritten against this (§14). */
  image_base_url: string;
};

/**
 * The cache key is built from path parameters, so the vocabulary is pinned to what GitHub
 * actually allows in an owner or repo name. Without this, `..%2f..%2f` reads arbitrary blobs.
 */
const Params = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
});

export const readmeRoutes: FastifyPluginAsync<{ cache: ReadOnlyCache }> = async (app, options) => {
  const { cache } = options;

  app.get<{ Params: { owner: string; repo: string } }>('/:owner/:repo', async (request, reply) => {
    const parsed = Params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const fullName = `${parsed.data.owner}/${parsed.data.repo}`;
    const keys = repoKeys(fullName);

    const [markdown, meta] = await Promise.all([
      cache.getText(keys.readme),
      cache.getJSON<ReadmeMeta>(keys.readmeMeta),
    ]);

    if (markdown === null) return reply.code(404).send({ error: 'not_found' });

    const html = await renderReadme(
      markdown,
      // A cached README with no cached metadata is a crawler gap, not a reason to 500. GitHub's
      // own raw host resolves relative paths correctly for the default branch.
      meta?.image_base_url ?? `https://raw.githubusercontent.com/${fullName}/HEAD/`,
    );

    return reply
      .header('cache-control', 'public, max-age=300')
      .send({ repo: fullName, html });
  });
};
