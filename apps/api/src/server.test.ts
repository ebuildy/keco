import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from './env';
import { build } from './server';

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });
const app = await build({ env });

afterAll(() => app.close());

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
