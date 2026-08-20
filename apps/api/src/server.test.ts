import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from './env';
import { build } from './server';

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });
const app = await build({ env });
const throwingApp = await build({ env, registerThrowingTestRoute: true });

afterAll(() => Promise.all([app.close(), throwingApp.close()]));

describe('build()', () => {
  it('reports its own health without touching Meilisearch', async () => {
    // Health must not depend on a downstream: a probe that fails when the search index is
    // down takes the process out of rotation for something it cannot fix by restarting.
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers an unknown /api path with JSON, never the SPA shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });
});

describe('the root error handler', () => {
  // admin and commands are the two auth-bearing route groups with no scoped error handler
  // of their own (§14) — an unhandled throw in either used to fall through to Fastify's
  // default serializer, which echoes error.message into the response body.
  it("never leaks an unhandled throw's message for an unscoped route", async () => {
    const response = await throwingApp.inject({ method: 'GET', url: '/api/admin/__throws_for_tests' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('internal detail');
    expect(response.json()).toEqual({ error: 'internal_error' });
  });
});
