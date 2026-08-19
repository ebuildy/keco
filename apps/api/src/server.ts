import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env';
import { liveRetrieval, type Retrieval } from './ports';
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

  const app = Fastify({
    logger: { level: options.env.LOG_LEVEL },
    // owner/repo paths are the public identifier; nothing here needs a trailing-slash variant.
    // Nested under routerOptions deliberately: the top-level spelling is deprecated in
    // Fastify 5 (FSTDEP022) and gone in 6, and it warns on every instance a test builds.
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  await app.register(v1Routes, { prefix: '/api/v1', retrieval });

  // Replaced in Task 9 by the handler that also serves the SPA and the prerendered pages.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));

  await app.ready();
  return app;
}
