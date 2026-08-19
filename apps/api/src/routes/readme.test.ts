import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { build } from '../server';

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });

const files: Record<string, string> = {
  'repos/ahmetb/kubectx/readme.md': '# kubectx\n\n<script>alert(1)</script>\n\n![logo](docs/l.png)',
  'repos/ahmetb/kubectx/readme.json': JSON.stringify({
    path: 'README.md',
    branch: 'master',
    etag: null,
    image_base_url: 'https://raw.githubusercontent.com/ahmetb/kubectx/master/',
  }),
};

const app = await build({
  env,
  retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
  cache: {
    getText: async (key: string) => files[key] ?? null,
    getJSON: async <T>(key: string) => (files[key] ? (JSON.parse(files[key]) as T) : null),
  },
});

afterAll(() => app.close());

describe('GET /api/readme/:owner/:repo', () => {
  it('returns sanitised HTML with relative images rewritten', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/readme/ahmetb/kubectx' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.repo).toBe('ahmetb/kubectx');
    expect(body.html).toContain('<h1>kubectx</h1>');
    expect(body.html).not.toContain('<script');
    expect(body.html).toContain('https://raw.githubusercontent.com/ahmetb/kubectx/master/docs/l.png');
  });

  it('404s a repo whose README is not cached yet', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/readme/nobody/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('rejects a repo name that could escape the cache key space', async () => {
    // The cache key is built from user input; a traversal here would read arbitrary blobs.
    const response = await app.inject({ method: 'GET', url: '/api/readme/ahmetb/..%2f..%2fjournal' });
    expect(response.statusCode).toBe(400);
  });
});
