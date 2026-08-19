import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { build } from '../server';

const env = loadEnv({
  MEILI_MASTER_KEY: 'k',
  SESSION_SECRET: 'a'.repeat(32),
  LOG_LEVEL: 'fatal',
  COMMAND_TOKEN: 'right-token',
});

const app = await build({
  env,
  retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
  cache: { getText: async () => null, getJSON: async () => null },
});

afterAll(() => app.close());

const post = (url: string, token?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { repo: 'ahmetb/kubectx' },
  });

describe('POST /api/commands/:command', () => {
  it('rejects a request with no credential', async () => {
    const response = await post('/api/commands/recrawl');
    expect(response.statusCode).toBe(401);
  });

  it('rejects the wrong token', async () => {
    expect((await post('/api/commands/recrawl', 'wrong-token')).statusCode).toBe(401);
  });

  it('rejects an unknown command even with the right token', async () => {
    const response = await post('/api/commands/drop-everything', 'right-token');
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('unknown_command');
  });

  it('accepts a known command with the right token', async () => {
    const response = await post('/api/commands/recrawl', 'right-token');
    // Still 501 until the journal append lands — but the auth and vocabulary gates are real.
    expect(response.statusCode).toBe(501);
    expect(response.json().command).toBe('recrawl');
  });

  it('is not CORS-open, unlike /api/v1', async () => {
    const response = await post('/api/commands/recrawl', 'right-token');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('MCP and chat', () => {
  it('lists the MCP tools by name', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/mcp' });
    expect(response.statusCode).toBe(200);
    expect(response.json().tools).toContain('search_tools');
  });

  it('reports chat as not implemented', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: {} });
    expect(response.statusCode).toBe(501);
  });
});
