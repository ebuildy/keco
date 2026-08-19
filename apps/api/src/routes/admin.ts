import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../auth';
import type { Env } from '../env';
import { SESSION_COOKIE, hasAdminSession } from '../session';

/**
 * Backoffice auth (AGENTS.md §12): one admin credential, a signed HttpOnly session cookie,
 * and nothing else. The backoffice can only read and enqueue, so there is no role model to
 * build.
 *
 * The backoffice SPA itself is not in this deployment yet; these routes are the contract it
 * will use, and /api/commands/* already accepts the session they issue.
 */
const Credentials = z.object({ password: z.string().min(1) });

export const adminRoutes: FastifyPluginAsync<{ env: Env }> = async (app, options) => {
  const { env } = options;

  app.post('/login', async (request, reply) => {
    const parsed = Credentials.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    // An unset hash means no admin exists. Fail closed rather than treating "unconfigured"
    // as "open".
    const stored = env.ADMIN_PASSWORD_HASH ?? '';
    if (!(await verifyPassword(parsed.data.password, stored))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    return reply
      .setCookie(SESSION_COOKIE, 'admin', {
        signed: true,
        httpOnly: true,
        sameSite: 'strict',
        secure: env.SITE_URL.startsWith('https://'),
        path: '/',
        maxAge: 60 * 60 * 12,
      })
      .send({ admin: true });
  });

  app.post('/logout', async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ admin: false }),
  );

  app.get('/session', async (request, reply) => {
    // Authorize inside the handler, not only in a hook (§12).
    if (!hasAdminSession(request)) return reply.code(401).send({ error: 'unauthorized' });
    return { admin: true };
  });
};
