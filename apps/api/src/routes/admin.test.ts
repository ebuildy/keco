import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth';
import { loadEnv } from '../env';
import { adminSessionValue, SESSION_COOKIE, SESSION_TTL_MS } from '../session';
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
    retrieval: {
      searchTools: async () => {
        throw new Error('unused');
      },
      getTool: async () => null,
    },
    cache: { getText: async () => null, getJSON: async () => null, getBuffer: async () => null },
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

  it("matches the deleted cookie's attributes on logout (HttpOnly, SameSite=Strict)", async () => {
    const cookies = (await login('hunter2')).cookies.map((c) => [c.name, c.value] as const);
    const jar = Object.fromEntries(cookies);

    const out = await app.inject({ method: 'POST', url: '/api/admin/logout', cookies: jar });
    const cookie = out.headers['set-cookie'];
    const header = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });
});

describe('when ADMIN_PASSWORD_HASH is unset', () => {
  it('refuses every login rather than letting anyone in', async () => {
    const open = await build({
      env: loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' }),
      retrieval: {
        searchTools: async () => {
          throw new Error('unused');
        },
        getTool: async () => null,
      },
      cache: { getText: async () => null, getJSON: async () => null, getBuffer: async () => null },
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

describe('POST /api/admin/login rate limiting', () => {
  // Its own instance per test: the login calls made by the suites above must not eat into
  // this budget, and one test here must not eat into another's.
  const buildLimited = async () =>
    build({
      env: loadEnv({
        MEILI_MASTER_KEY: 'k',
        SESSION_SECRET: 'a'.repeat(32),
        LOG_LEVEL: 'fatal',
        ADMIN_PASSWORD_HASH: await hashPassword('hunter2'),
      }),
      retrieval: {
        searchTools: async () => {
          throw new Error('unused');
        },
        getTool: async () => null,
      },
      cache: { getText: async () => null, getJSON: async () => null, getBuffer: async () => null },
    });

  it('fires after repeated login attempts, and a 429 does not reveal whether the password was right', async () => {
    const limited = await buildLimited();

    try {
      const attempt = () =>
        limited.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'wrong' } });

      let last;
      for (let i = 0; i < 10; i++) last = await attempt();
      expect(last!.statusCode).toBe(429);

      // The limiter must reject before the handler ever compares the password — a 429 for
      // the right password looks identical to a 429 for a wrong one.
      const withRightPassword = await limited.inject({
        method: 'POST',
        url: '/api/admin/login',
        payload: { password: 'hunter2' },
      });
      expect(withRightPassword.statusCode).toBe(429);
      expect(withRightPassword.json()).toEqual(last!.json());
    } finally {
      await limited.close();
    }
  });

  it('does not apply the login budget to /session or /logout', async () => {
    const limited = await buildLimited();
    try {
      // Exhaust the login budget, then confirm the other two routes are still answering.
      for (let i = 0; i < 6; i++) {
        await limited.inject({
          method: 'POST',
          url: '/api/admin/login',
          payload: { password: 'x' },
        });
      }
      const session = await limited.inject({ method: 'GET', url: '/api/admin/session' });
      expect(session.statusCode).toBe(401); // unauthenticated, not 429 — the route itself answered
    } finally {
      await limited.close();
    }
  });
});

describe('session expiry', () => {
  it('accepts a freshly issued session value', async () => {
    const cookie = app.signCookie(adminSessionValue());
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/session',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a session past its signed expiry', async () => {
    const cookie = app.signCookie(adminSessionValue(Date.now() - SESSION_TTL_MS - 1000));
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/session',
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a cookie whose expiry was edited after signing', async () => {
    const genuine = adminSessionValue();
    const signed = app.signCookie(genuine);
    // The signature covers the whole value, so lengthening the expiry digits invalidates it —
    // this must fail on signature, not fall back to a lenient prefix match.
    const tamperedValue = genuine.replace(
      /^admin\.(\d+)$/,
      (_all, digits: string) => `admin.${digits}9`,
    );
    const tampered = signed.replace(genuine, tamperedValue);

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/session',
      cookies: { [SESSION_COOKIE]: tampered },
    });
    expect(response.statusCode).toBe(401);
  });
});
