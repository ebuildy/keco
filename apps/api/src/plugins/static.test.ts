import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env';
import { build } from '../server';
import { loadPrerenderManifest, resolveDist } from './static';

let dist: string;
let app: FastifyInstance;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'keco-dist-'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><div id="root"></div>SPA SHELL');
  await mkdir(join(dist, 'prerendered', 'tools', 'ahmetb'), { recursive: true });
  await writeFile(
    join(dist, 'prerendered', 'tools', 'ahmetb', 'kubectx.html'),
    '<!doctype html><h1>ahmetb/kubectx</h1>PRERENDERED',
  );
  await writeFile(
    join(dist, 'prerender-manifest.json'),
    JSON.stringify({ paths: ['/tools/ahmetb/kubectx'] }),
  );
  await writeFile(join(dist, 'sitemap.xml'), '<urlset/>');

  app = await build({
    env: loadEnv({
      MEILI_MASTER_KEY: 'k',
      SESSION_SECRET: 'a'.repeat(32),
      LOG_LEVEL: 'fatal',
      WEB_DIST: dist,
    }),
    retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
    cache: { getText: async () => null, getJSON: async () => null },
    prerendered: await loadPrerenderManifest(dist),
  });
});

afterAll(async () => {
  await app.close();
  await rm(dist, { recursive: true, force: true });
});

describe('static serving', () => {
  it('serves index.html at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('SPA SHELL');
  });

  it('serves a real asset from the dist directory', async () => {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<urlset/>');
  });

  it('does not shadow /api — a JSON route still answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('the not-found fallback', () => {
  it('serves the prerendered file for a path the manifest lists', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/ahmetb/kubectx' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('PRERENDERED');
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves the SPA shell for a route the prerender did not emit', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/nobody/nothing' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('SPA SHELL');
  });

  it('serves the SPA shell for a client route with no file behind it', async () => {
    const response = await app.inject({ method: 'GET', url: '/search?q=ingress' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('SPA SHELL');
  });

  it('answers an unknown /api path with JSON, never the shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).not.toContain('SPA SHELL');
  });

  it('reserves /admin as a noindex 404 until the backoffice ships', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-robots-tag']).toBe('noindex');
  });

  it('does not serve the shell for a non-GET request', async () => {
    const response = await app.inject({ method: 'POST', url: '/tools/ahmetb/kubectx' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('SPA SHELL');
  });
});

describe('loadPrerenderManifest', () => {
  it('reads the paths the prerender emitted', async () => {
    expect(await loadPrerenderManifest(dist)).toEqual(new Set(['/tools/ahmetb/kubectx']));
  });

  it('returns an empty set when there is no manifest', async () => {
    // A dev server with no prerender run must still boot; every route just falls back.
    expect(await loadPrerenderManifest(join(tmpdir(), 'keco-does-not-exist'))).toEqual(new Set());
  });
});

describe('resolveDist', () => {
  it('leaves an absolute path alone', () => {
    expect(resolveDist('/srv/keco/dist')).toBe('/srv/keco/dist');
  });

  it('anchors a relative path at the workspace root, not the cwd', () => {
    // `pnpm -F @keco/api dev` runs with cwd set to apps/api. Resolving against cwd turned
    // WEB_DIST=apps/web/dist into apps/api/apps/web/dist and every request 500'd.
    const root = resolve(import.meta.dirname, '..', '..', '..', '..');
    expect(resolveDist('apps/web/dist', join(root, 'apps', 'api'))).toBe(
      join(root, 'apps', 'web', 'dist'),
    );
    expect(resolveDist('apps/web/dist', root)).toBe(join(root, 'apps', 'web', 'dist'));
  });
});
