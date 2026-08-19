import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env';
import { liveCache, liveRetrieval, type ReadOnlyCache, type Retrieval } from './ports';
import { adminRoutes } from './routes/admin';
import { chatRoutes } from './routes/chat';
import { commandRoutes } from './routes/commands';
import { mcpRoutes } from './routes/mcp';
import { readmeRoutes } from './routes/readme';
import { v1Routes } from './routes/v1';

export type BuildOptions = {
  env: Env;
  /**
   * Paths the prerender emitted, loaded from the build manifest. Injected rather than read
   * here so tests can exercise the fallback without a dist directory. Task 9 wires the real
   * loader in `index.ts`.
   */
  prerendered?: Set<string>;
  /** Injected in tests so a route suite never needs a running Meilisearch (see ports.ts). */
  retrieval?: Retrieval;
  /** Injected in tests so a route suite never needs a `.cache` directory on disk (see ports.ts). */
  cache?: ReadOnlyCache;
};

/**
 * Builds the instance without listening, so every test drives it through `inject` and no
 * test opens a socket. `index.ts` is the only thing that calls `.listen()`.
 *
 * Registration order is load-bearing (§14): /api routes first, then the static plugin, then
 * the not-found handler last. Task 9 adds the last two.
 */
export async function build(options: BuildOptions): Promise<FastifyInstance> {
  const retrieval = options.retrieval ?? liveRetrieval(options.env);
  const cache = options.cache ?? liveCache(options.env);

  const app = Fastify({
    logger: { level: options.env.LOG_LEVEL },
    // owner/repo paths are the public identifier; nothing here needs a trailing-slash variant.
    // Nested under routerOptions deliberately: the top-level spelling is deprecated in
    // Fastify 5 (FSTDEP022) and gone in 6, and it warns on every instance a test builds.
    routerOptions: { ignoreTrailingSlash: true },
    // See env.ts: only true when a trusted reverse proxy fronts this process. Determines
    // where request.ip (and so the per-IP rate limiter in routes/v1.ts) reads its address from.
    trustProxy: options.env.TRUST_PROXY,
  });

  // Signed so a session cookie cannot be forged. HttpOnly and SameSite are set per-cookie
  // by the admin routes (§12).
  await app.register(cookie, { secret: options.env.SESSION_SECRET });

  app.get('/api/health', async () => ({ status: 'ok' }));

  await app.register(v1Routes, { prefix: '/api/v1', retrieval });
  await app.register(readmeRoutes, { prefix: '/api/readme', cache });
  await app.register(adminRoutes, { prefix: '/api/admin', env: options.env });
  await app.register(commandRoutes, { prefix: '/api/commands', env: options.env });
  await app.register(mcpRoutes, { prefix: '/api/mcp' });
  await app.register(chatRoutes, { prefix: '/api/chat' });

  // Replaced in Task 9 by the handler that also serves the SPA and the prerendered pages.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));

  await app.ready();
  return app;
}
