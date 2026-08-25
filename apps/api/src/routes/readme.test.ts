import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { warmReadmeRenderer } from '../readme/render';
import { build } from '../server';

// See render.test.ts: this route runs the full renderReadme pipeline, so it pays the same
// Shiki warm-up during import rather than inside whichever test happens to render first.
await warmReadmeRenderer();

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });

const TRUNCATION_MARKER = 'END_OF_README_MARKER_UNIQUE_TOKEN';

const files: Record<string, string> = {
  'repos/ahmetb/kubectx/readme.md': '# kubectx\n\n<script>alert(1)</script>\n\n![logo](docs/l.png)',
  'repos/ahmetb/kubectx/readme.json': JSON.stringify({
    path: 'README.md',
    branch: 'master',
    etag: null,
    image_base_url: 'https://raw.githubusercontent.com/ahmetb/kubectx/master/',
  }),
  // Well over the 64 KB render cap, with a marker at the very end: if the marker survives into
  // the rendered HTML, truncation did not actually happen.
  'repos/big/readme/readme.md': `# Big\n\n${'a'.repeat(70_000)}\n\n${TRUNCATION_MARKER}`,
  'repos/big/readme/readme.json': JSON.stringify({
    path: 'README.md',
    branch: 'main',
    etag: null,
    image_base_url: 'https://raw.githubusercontent.com/big/readme/HEAD/',
  }),
  'repos/evil/scheme/readme.md': '# evil\n\n![rel](rel.png)',
  // A base with a scheme that isn't https: rewriteUrls's try/catch only guards a URL that
  // fails to *parse* — new URL('rel.png', 'file:///etc/') parses fine.
  'repos/evil/scheme/readme.json': JSON.stringify({
    path: 'README.md',
    branch: 'main',
    etag: null,
    image_base_url: 'file:///etc/',
  }),
  'repos/broken/meta/readme.md': '# broken\n\n![rel](rel.png)',
  'repos/broken/meta/readme.json': JSON.stringify({ nonsense: true }),
};

const buildTestApp = () =>
  build({
    env,
    retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
    cache: {
      getText: async (key: string) => files[key] ?? null,
      getJSON: async <T>(key: string) => (files[key] ? (JSON.parse(files[key]) as T) : null),
      // This suite has no binary fixtures; the icon route has its own.
      getBuffer: async () => null,
    },
  });

const app = await buildTestApp();

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
    expect(body.truncated).toBe(false);
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

  it('truncates a README over the render cap instead of rendering it in full', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/readme/big/readme' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.truncated).toBe(true);
    expect(body.html).not.toContain(TRUNCATION_MARKER);
  });

  it('falls back to the GitHub-derived base when image_base_url is not https', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/readme/evil/scheme' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.html).not.toContain('file://');
    expect(body.html).toContain('https://raw.githubusercontent.com/evil/scheme/HEAD/rel.png');
  });

  it('falls back to the GitHub-derived base when readme.json fails schema validation', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/readme/broken/meta' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.html).toContain('https://raw.githubusercontent.com/broken/meta/HEAD/rel.png');
  });
});

describe('rate limiting', () => {
  it('answers 429 once a caller exceeds the per-IP limit on this route', async () => {
    // A fresh instance: the limiter counts per-process, and this must not be polluted by (or
    // pollute) the requests the other cases in this file make against the shared `app`.
    const limited = await buildTestApp();

    let last;
    for (let i = 0; i < 31; i++) {
      last = await limited.inject({ method: 'GET', url: '/api/readme/ahmetb/kubectx' });
    }

    expect(last?.statusCode).toBe(429);
    expect(last?.json()).toMatchObject({ error: 'rate_limited' });

    await limited.close();
  });
});
