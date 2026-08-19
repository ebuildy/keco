import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../auth';
import type { Env } from '../env';
import { SESSION_COOKIE, SESSION_TTL_MS, adminSessionValue, hasAdminSession } from '../session';

/**
 * Backoffice auth (AGENTS.md §12): one admin credential, a signed HttpOnly session cookie,
 * and nothing else. The backoffice can only read and enqueue, so there is no role model to
 * build.
 *
 * The backoffice SPA itself is not in this deployment yet; these routes are the contract it
 * will use, and /api/commands/* already accepts the session they issue.
 */
const Credentials = z.object({ password: z.string().min(1) });

/**
 * The tightest budget in the app, deliberately — measured, not guessed. `verifyPassword` runs
 * `crypto.scrypt` on Node's libuv threadpool (default `UV_THREADPOOL_SIZE=4`), which every
 * other cache/filesystem read in this process also queues on: /api/readme's cache reads today,
 * and @fastify/static plus prerendered-HTML serving once Task 9 lands. An unthrottled flood of
 * anonymous logins doesn't just brute-force the one admin password online — it starves that
 * shared threadpool and slows down every unrelated request in flight. `/login` is a human
 * typing a password, not a machine client, so 5/min is generous for the legitimate case and
 * still caps the CPU one anonymous caller can spend. Do not "harmonise" this with v1's 120/min:
 * that budget is for read-only Meilisearch lookups with no CPU-bound work behind them.
 */
const LOGIN_RATE_LIMIT = { max: 5, timeWindow: '1 minute' } as const;

export const adminRoutes: FastifyPluginAsync<{ env: Env }> = async (app, options) => {
  const { env } = options;

  // global: false — only /login opts in (below), via its own route config. /session and
  // /logout are cheap (no scrypt, no CPU) and must not share login's tighter budget.
  await app.register(rateLimit, { global: false });

  app.post('/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
    const parsed = Credentials.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    // An unset hash means no admin exists. Fail closed rather than treating "unconfigured"
    // as "open".
    const stored = env.ADMIN_PASSWORD_HASH ?? '';
    if (!(await verifyPassword(parsed.data.password, stored))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    return reply
      .setCookie(SESSION_COOKIE, adminSessionValue(), {
        signed: true,
        httpOnly: true,
        sameSite: 'strict',
        secure: env.SITE_URL.startsWith('https://'),
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      })
      .send({ admin: true });
  });

  app.post('/logout', async (_request, reply) =>
    reply
      // Same attributes as the cookie being deleted (setCookie above), so the deletion
      // matches what it's deleting rather than falling back to @fastify/cookie's defaults
      // (SameSite=Lax, no HttpOnly/Secure). Deletion works either way — this is consistency.
      .clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        sameSite: 'strict',
        secure: env.SITE_URL.startsWith('https://'),
        path: '/',
      })
      .send({ admin: false }),
  );

  app.get('/session', async (request, reply) => {
    // Authorize inside the handler, not only in a hook (§12).
    if (!hasAdminSession(request)) return reply.code(401).send({ error: 'unauthorized' });
    return { admin: true };
  });
};
