import { afterAll, describe, expect, it } from 'vitest';
import type { ToolDocument } from '@keco/core';
import { loadEnv } from '../env';
import { build } from '../server';

const tool = {
  id: 'ahmetb__kubectx',
  owner: 'ahmetb',
  name: 'kubectx',
  full_name: 'ahmetb/kubectx',
  summary: 'Fast context and namespace switching for kubectl.',
  kind: 'cli',
  domains: ['dev-experience'],
  stars: 18000,
  archived: false,
  repo_url: 'https://github.com/ahmetb/kubectx',
  install_methods: [
    { method: 'brew', command: 'brew install kubectx', source_url: 'https://formulae.brew.sh/formula/kubectx', verified_at: '2026-08-01T00:00:00.000Z' },
  ],
  score: { popularity: 0.9, activity: 0.8, adoption: 0.9, quality: 0.8, quality_coverage: 0.75, total: 0.86, momentum: 1.2 },
  indexed_at: '2026-08-18T00:00:00.000Z',
} as unknown as ToolDocument;

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });

/** Records what each route asked retrieval for, so the tests can assert on the translation. */
const calls: unknown[] = [];

const app = await build({
  env,
  retrieval: {
    searchTools: async (params) => {
      calls.push(params);
      return { hits: [tool], total: 1, page: 1, hitsPerPage: 20, facets: { kind: { cli: 1 } }, processingTimeMs: 3 };
    },
    getTool: async (fullName) => (fullName === 'ahmetb/kubectx' ? tool : null),
  },
});

afterAll(() => app.close());

describe('GET /api/v1/search', () => {
  it('returns the public projection, never the raw document id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=context' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.results[0]).toMatchObject({
      repo: 'ahmetb/kubectx',
      url: '/tools/ahmetb/kubectx',
      repo_url: 'https://github.com/ahmetb/kubectx',
      indexed_at: '2026-08-18T00:00:00.000Z',
    });
    // The public identifier is owner/repo; internal ids never leak (§11).
    expect(body.results[0]).not.toHaveProperty('id');
  });

  it('is CORS-open, because it is anonymous and read-only', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search' });
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('reads taxonomy facets from their declared URL parameters', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?domain=security,policy&install=krew' });
    expect(calls.at(-1)).toMatchObject({
      filters: { domains: ['security', 'policy'], install_methods: ['krew'] },
    });
  });

  it('falls back to relevance for a sort key that is not in the vocabulary', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?sort=stars:desc;drop' });
    expect(calls.at(-1)).toMatchObject({ sort: 'relevance' });
  });

  it('caps the page size so one caller cannot ask for the whole corpus', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?limit=5000' });
    expect(calls.at(-1)).toMatchObject({ hitsPerPage: 50 });
  });
});

describe('when Meilisearch is unreachable', () => {
  it('answers 503 without leaking a stack trace', async () => {
    const broken = await build({
      env,
      retrieval: {
        searchTools: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:7700');
        },
        getTool: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:7700');
        },
      },
    });

    const response = await broken.inject({ method: 'GET', url: '/api/v1/search?q=x' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'search_unavailable' });
    // An internal address and a stack are operational detail, not a public API.
    expect(response.body).not.toContain('ECONNREFUSED');
    await broken.close();
  });
});

describe('GET /api/v1/tools/:owner/:repo', () => {
  it('returns the full document', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tools/ahmetb/kubectx' });
    expect(response.statusCode).toBe(200);
    expect(response.json().full_name).toBe('ahmetb/kubectx');
  });

  it('404s a repo that is not in the index', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tools/nobody/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });
});
