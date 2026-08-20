import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The default error handler for every route group that does not set its own — admin,
 * commands, mcp and chat today (AGENTS.md §14). `routes/v1.ts` and `routes/readme.ts` keep
 * their own scoped handlers because their behaviour is genuinely specific (v1 turns a
 * downstream Meilisearch failure into a 503 with no internal detail; readme's guards the same
 * way, over a route with no external dependency to blame a 500 on) — this is what the *rest*
 * of the app fell through to before this existed: Fastify's default serializer, which echoes
 * `error.message` (and can include a stack) straight into the response body. Two of the
 * groups that inherit this handler are auth-bearing (admin, commands); an unhandled throw
 * there leaking implementation detail is a worse outcome than on a read-only route.
 *
 * A 4xx (validation, `@fastify/rate-limit`, Fastify's own body-parsing errors) still echoes
 * `error.message` — that is the existing convention in v1 and readme, and a validation message
 * is not the kind of internal detail this guards against. Only 5xx is generic.
 */
export function rootErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    const code = status === 429 ? 'rate_limited' : (error.code ?? 'bad_request');
    return reply.code(status).send({ error: code, message: error.message });
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send({ error: 'internal_error' });
}
