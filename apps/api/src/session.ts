import type { FastifyRequest } from 'fastify';

/** The signed admin session cookie (§12). One admin, one cookie, no roles. */
export const SESSION_COOKIE = 'keco_admin';

/**
 * 12 hours. Also the cookie's `maxAge` (set in `routes/admin.ts`), but `maxAge` is only a
 * browser hint — nothing stops a captured cookie from being replayed after the browser would
 * have dropped it. The expiry below is signed into the value itself and checked server-side on
 * every request, so a leaked cookie still expires on its own and a client-side "logout" is not
 * the only way a session ends.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Strict — anchored both ends, not a prefix match, so `admin.123extra` does not pass. */
const SESSION_VALUE = /^admin\.(\d+)$/;

/** Builds the signed cookie payload for a freshly authenticated admin. */
export function adminSessionValue(now = Date.now()): string {
  return `admin.${now + SESSION_TTL_MS}`;
}

/**
 * True when the request carries a valid signed admin session that has not expired.
 *
 * Every handler that needs this calls it directly. §12 is explicit that authorization belongs
 * inside the handler, not only in a plugin hook — a route that trusts an upstream guard is one
 * refactor away from being unguarded.
 */
export function hasAdminSession(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;

  const match = SESSION_VALUE.exec(unsigned.value);
  if (!match) return false;

  const expiresAt = Number(match[1]);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}
