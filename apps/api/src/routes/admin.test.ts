import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth';
import { loadEnv } from '../env';
import { build } from '../server';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await build({
    env: loadEnv({
      MEILI_MASTER_KEY: 'k',
      SESSION_SECRET: 'a'.repeat(32),
      LOG_LEVEL: 'fatal',
      ADMIN_PASSWORD_HASH: await hashPassword('hunter2'),
    }),
    retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
    cache: { getText: async () => null, getJSON: async () => null },
  });
});

afterAll(() => app.close());

const login = (password: string) =>
  app.inject({ method: 'POST', url: '/api/admin/login', payload: { password } });

describe('POST /api/admin/login', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie on the right password', async () => {
    const response = await login('hunter2');
    expect(response.statusCode).toBe(200);
    const cookie = response.headers['set-cookie'];
    const header = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });

  it('rejects the wrong password without saying which part was wrong', async () => {
    const response = await login('wrong');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a malformed body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/admin/session', () => {
  it('reports no session before login', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/admin/session' });
    expect(response.statusCode).toBe(401);
  });

  it('reports a session after login, and none after logout', async () => {
    const cookies = (await login('hunter2')).cookies.map((c) => [c.name, c.value] as const);
    const jar = Object.fromEntries(cookies);

    const session = await app.inject({ method: 'GET', url: '/api/admin/session', cookies: jar });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ admin: true });

    const out = await app.inject({ method: 'POST', url: '/api/admin/logout', cookies: jar });
    expect(out.statusCode).toBe(200);
  });
});

describe('when ADMIN_PASSWORD_HASH is unset', () => {
  it('refuses every login rather than letting anyone in', async () => {
    const open = await build({
      env: loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' }),
      retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
      cache: { getText: async () => null, getJSON: async () => null },
    });
    const response = await open.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: 'anything' },
    });
    expect(response.statusCode).toBe(401);
    await open.close();
  });
});
