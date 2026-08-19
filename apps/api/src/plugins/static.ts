import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * Serves the portal bundle alongside the JSON routes (AGENTS.md §7: one Node process in
 * production, next to Meilisearch and the worker container).
 *
 * Two §14 traps are the whole reason this file exists:
 *
 *   - Static must not shadow /api/*. `wildcard: false` keeps @fastify/static from claiming
 *     every unmatched path, so the JSON routes registered before it still win.
 *   - The SPA has no server. `/tools/argoproj/argo-cd` resolves only because the not-found
 *     handler falls back — add a client route without checking this and the URL 404s on a
 *     hard refresh.
 *
 * Note for whoever tunes this later: `crypto.scrypt` in the admin login path (routes/admin.ts)
 * runs on the libuv threadpool, and so does every file read this plugin performs —
 * `@fastify/static`'s asset serving and the `sendFile` calls in the not-found handler below.
 * A flood of static/prerendered requests competes with login hashing for the same four
 * threadpool slots by default; if login latency degrades under static traffic (or vice versa),
 * look at `UV_THREADPOOL_SIZE` before reaching for anything more elaborate.
 */
const Manifest = z.object({ paths: z.array(z.string()) });

const MANIFEST_FILE = 'prerender-manifest.json';

/**
 * The set of paths the prerender emitted, read once at boot.
 *
 * A membership test on our own build output, rather than an `fs.stat` per request: it is
 * faster, and it means a crafted URL can never be turned into a path lookup — nothing outside
 * this set is ever used to build a filename.
 *
 * A missing manifest is normal (a dev server, or a build before the first prerender run) and
 * yields an empty set: every route then falls back to the SPA shell.
 */
export async function loadPrerenderManifest(distDir: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(distDir, MANIFEST_FILE), 'utf8');
    return new Set(Manifest.parse(JSON.parse(raw)).paths);
  } catch {
    return new Set();
  }
}

/** Relative WEB_DIST resolves against the workspace root, like CACHE_DIR does (§3). */
export const resolveDist = (dist: string, from = process.cwd()): string =>
  isAbsolute(dist) ? dist : resolve(from, dist);

export type StaticOptions = { dist: string; prerendered: Set<string> };

export const staticPlugin: FastifyPluginAsync<StaticOptions> = async (app, options) => {
  const root = resolveDist(options.dist);

  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    // Without this, @fastify/static registers a catch-all that swallows /api/* and the SPA
    // fallback below never runs.
    wildcard: false,
    index: ['index.html'],
  });

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';

    // JSON in, JSON out. An API caller must never receive an HTML shell with a 200-looking
    // body it cannot parse.
    if (path === '/api' || path.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Reserved for apps/backoffice, which is not in this deployment yet. noindex either way:
    // §9 says /admin is never indexed and never prerendered.
    if (path === '/admin' || path.startsWith('/admin/')) {
      return reply.code(404).header('x-robots-tag', 'noindex').send({ error: 'not_found' });
    }

    // Only a document request gets the shell. A POST to a client route is a mistake, not a
    // navigation, and answering it with 200 HTML hides that.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not_found' });
    }

    if (options.prerendered.has(path)) {
      // `path` came from the manifest, not from the request, so this cannot be walked out of
      // the dist directory.
      return reply.type('text/html').sendFile(join('prerendered', `${path.slice(1)}.html`));
    }

    return reply.type('text/html').sendFile('index.html');
  });
};
