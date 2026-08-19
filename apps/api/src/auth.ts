import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Backoffice auth is a single admin credential, not an auth system (AGENTS.md §12). There is
 * one admin and the backoffice can only read and enqueue, so an OAuth provider would be more
 * moving parts than the surface justifies.
 *
 * scrypt rather than a bare digest: ADMIN_PASSWORD_HASH sits in an env file, and a password
 * hashed with sha256 there is a password, not a hash.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SCHEME = 'scrypt';

/** Produces the `ADMIN_PASSWORD_HASH` value. See `src/bin/hash-password.ts`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Fails closed on anything it does not recognise. A malformed or empty stored value means the
 * deployment is misconfigured, and the safe reading of that is "nobody is the admin".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== SCHEME || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const salt = Buffer.from(saltHex, 'hex');
  if (expected.length !== KEY_LENGTH || salt.length === 0) return false;

  const actual = await scrypt(password, salt, KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}

/**
 * For the command token (§12). An empty expected value is never equal to anything — an unset
 * COMMAND_TOKEN must not make every caller authorized.
 */
export function constantTimeEquals(provided: string, expected: string): boolean {
  if (expected === '' || provided === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a leak of nothing useful:
  // the length of a token is not a secret, but the comparison still must not short-circuit.
  return a.length === b.length && timingSafeEqual(a, b);
}
