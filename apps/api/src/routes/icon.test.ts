import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { build } from '../server';

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });

/** A real, tiny PNG — the route must not care what is in it, only that it is served verbatim. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwynn6HwAE2gKDj5MdkgAAAABJRU5ErkJggg==',
  'base64',
);

const files: Record<string, Buffer> = {
  'repos/derailed/k9s/icon-32.png': PNG,
  'repos/derailed/k9s/icon-64.png': PNG,
  'repos/derailed/k9s/icon-160.png': PNG,
};

const app = await build({
  env,
  retrieval: {
    searchTools: async () => {
      throw new Error('unused');
    },
    getTool: async () => null,
  },
  cache: {
    getText: async () => null,
    getJSON: async () => null,
    getBuffer: async (key: string) => files[key] ?? null,
  },
});

afterAll(() => app.close());

describe('GET /api/icon/:owner/:repo/:size.png', () => {
  it('serves the derived PNG for each declared size', async () => {
    for (const size of [32, 64, 160]) {
      const response = await app.inject({ method: 'GET', url: `/api/icon/derailed/k9s/${size}.png` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.rawPayload).toEqual(PNG);
    }
  });

  /**
   * An SVG logo is rasterised to PNG before it is ever stored, so nothing active reaches a
   * reader. These headers are the belt to that braces: `nosniff` stops a browser deciding the
   * bytes are markup, and the CSP means a document served from here can load nothing.
   */
  it('serves with nosniff and a CSP that permits nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/icon/derailed/k9s/64.png' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'");
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
  });

  // An uncrawled repo is a miss, not an error. The portal already knows from the document
  // whether an icon exists, so this path is rare by construction.
  it('404s for a repo with no icon in the cache', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/icon/acme/widget/64.png' });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a size it does not derive', async () => {
    for (const size of ['128', '0', '1024']) {
      const response = await app.inject({ method: 'GET', url: `/api/icon/derailed/k9s/${size}.png` });
      expect(response.statusCode).toBe(400);
    }
  });

  // The cache key is built from path parameters, so this is a traversal surface.
  it('refuses owner and repo names GitHub could not issue', async () => {
    const urls = [
      '/api/icon/..%2f..%2fetc/passwd/64.png',
      '/api/icon/-bad/repo/64.png',
      '/api/icon/owner/re%2Fpo/64.png',
    ];
    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).not.toBe(200);
    }
  });
});
