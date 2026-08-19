import type { FastifyRequest } from 'fastify';

/** The signed admin session cookie (§12). One admin, one cookie, no roles. */
export const SESSION_COOKIE = 'keco_admin';

/**
 * True when the request carries a valid signed admin session.
 *
 * Every handler that needs this calls it directly. §12 is explicit that authorization belongs
 * inside the handler, not only in a plugin hook — a route that trusts an upstream guard is one
 * refactor away from being unguarded.
 */
export function hasAdminSession(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value === 'admin';
}
