import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PRERENDER_MANIFEST_FILE } from '@keco/core';
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

/** Minimal shape this module needs to log — satisfied by both `console` and a pino instance. */
export type ManifestLoadLogger = { info: (message: string) => void; warn: (message: string) => void };

/**
 * The set of paths the prerender emitted, read once at boot.
 *
 * A membership test on our own build output, rather than an `fs.stat` per request: it is
 * faster, and it means a crafted URL can never be turned into a path lookup — nothing outside
 * this set is ever used to build a filename.
 *
 * A missing manifest is a normal state (a dev server, or a build before the first prerender
 * run) and yields an empty set: every route then falls back to the SPA shell. A *present but
 * unreadable or malformed* manifest is not normal — it means a build produced a broken
 * artifact — and used to be swallowed into the exact same empty set with no signal at all, so
 * a silently-broken prerender was indistinguishable from an empty index at every layer above
 * this one. Both cases still degrade to the SPA shell (§9: never fail the boot over this), but
 * only the absent case is logged as expected.
 */
export async function loadPrerenderManifest(
  distDir: string,
  logger: ManifestLoadLogger = console,
): Promise<Set<string>> {
  const path = join(distDir, PRERENDER_MANIFEST_FILE);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info(`${path} not found — every route falls back to the SPA shell (run \`mise run prerender\`)`);
    } else {
      logger.warn(`${path} could not be read (${(error as Error).message}) — every route falls back to the SPA shell`);
    }
    return new Set();
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    logger.warn(`${path} is not valid JSON (${(error as Error).message}) — every route falls back to the SPA shell`);
    return new Set();
  }

  const parsed = Manifest.safeParse(json);
  if (!parsed.success) {
    logger.warn(`${path} does not match the expected manifest shape — every route falls back to the SPA shell`);
    return new Set();
  }

  return new Set(parsed.data.paths);
}

/**
 * Relative WEB_DIST resolves against the workspace root, like CACHE_DIR does (§3) — and for
 * the same reason: `pnpm -F @keco/api dev` runs with cwd set to `apps/api`, so resolving
 * against cwd turns `apps/web/dist` into `apps/api/apps/web/dist` and every request 500s.
 * That is the documented dev command, so cwd is exactly the wrong anchor.
 *
 * Mirrors `resolveCacheDir` in packages/cache: walk up for the workspace marker, and fall
 * back to cwd only if there is none.
 */
export function resolveDist(dist: string, from = process.cwd()): string {
  if (isAbsolute(dist)) return dist;
  for (let current = from; ; current = dirname(current)) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return resolve(current, dist);
    if (dirname(current) === current) return resolve(from, dist);
  }
}

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
