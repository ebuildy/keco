import { describe, expect, it } from 'vitest';
import { constantTimeEquals, hashPassword, verifyPassword } from './auth';

describe('hashPassword / verifyPassword', () => {
  it('round-trips the right password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct Horse Battery Staple', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects a malformed stored value instead of throwing', async () => {
    // A half-configured ADMIN_PASSWORD_HASH must fail closed, not 500 the login route.
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$aa$bb')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$zz$zz')).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('compares equal strings as equal', () => {
    expect(constantTimeEquals('token', 'token')).toBe(true);
  });

  it('rejects different values, including different lengths', () => {
    expect(constantTimeEquals('token', 'tokes')).toBe(false);
    expect(constantTimeEquals('token', 'token-longer')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(false);
  });
});
