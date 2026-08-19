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

  it('floors non-integer paging so Meilisearch never sees a fraction', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?page=2.9&limit=20.7' });
    expect(calls.at(-1)).toMatchObject({ page: 2, hitsPerPage: 20 });
  });

  it("caps deep paging at the read model's pagination.maxTotalHits (§5), not just the page size", async () => {
    // hitsPerPage defaults to 20; maxTotalHits is 10 000 (packages/search/src/settings.ts),
    // so page 500 is the last one Meilisearch will serve — anything past it is clamped.
    await app.inject({ method: 'GET', url: '/api/v1/search?page=1000000000' });
    expect(calls.at(-1)).toMatchObject({ page: 500, hitsPerPage: 20 });
  });
});

describe('rate limiting', () => {
  const emptyRetrieval = {
    searchTools: async () => ({
      hits: [],
      total: 0,
      page: 1,
      hitsPerPage: 20,
      facets: {},
      processingTimeMs: 1,
    }),
    getTool: async () => null,
  };

  it('answers 429, not 503, once a caller exceeds the per-IP limit, with retry-after intact', async () => {
    // A fresh instance: the limiter counts per-process, and this must not be polluted by
    // (or pollute) the requests the other cases in this file make against `app`.
    const limited = await build({ env, retrieval: emptyRetrieval });

    let last;
    for (let i = 0; i < 121; i++) {
      last = await limited.inject({ method: 'GET', url: '/api/v1/search' });
    }

    // This is the regression this suite exists to catch: the limiter's 429 must reach the
    // caller as a 429, not be swallowed by the 503 branch below it (Finding 1).
    expect(last?.statusCode).toBe(429);
    expect(last?.headers['retry-after']).toBeDefined();
    expect(last?.json()).toMatchObject({ error: 'rate_limited' });

    await limited.close();
  });
});

describe('TRUST_PROXY', () => {
  const emptyRetrieval = {
    searchTools: async () => ({
      hits: [],
      total: 0,
      page: 1,
      hitsPerPage: 20,
      facets: {},
      processingTimeMs: 1,
    }),
    getTool: async () => null,
  };

  // Same socket address, different forwarded client, sent one after the other — the rate
  // limiter's bucket is how the wiring is observable from outside Fastify's internals, and
  // the two requests must be strictly ordered or the counter race makes the assertion flaky.
  const sameSocketDifferentForwardedFor = async (instance: Awaited<ReturnType<typeof build>>) => {
    const first = await instance.inject({
      method: 'GET',
      url: '/api/v1/search',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    const second = await instance.inject({
      method: 'GET',
      url: '/api/v1/search',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });
    return [first, second] as const;
  };

  it('defaults to false: two callers behind one untrusted proxy share a single bucket', async () => {
    const untrusted = await build({
      env: loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' }),
      retrieval: emptyRetrieval,
    });

    const [first, second] = await sameSocketDifferentForwardedFor(untrusted);
    // Same bucket: the second request is one further into it than the first.
    expect(Number(second.headers['x-ratelimit-remaining'])).toBe(
      Number(first.headers['x-ratelimit-remaining']) - 1,
    );

    await untrusted.close();
  });

  it('when true, keys the limiter off X-Forwarded-For so a trusted proxy does not collapse every caller into one bucket', async () => {
    const trusted = await build({
      env: loadEnv({
        MEILI_MASTER_KEY: 'k',
        SESSION_SECRET: 'a'.repeat(32),
        LOG_LEVEL: 'fatal',
        TRUST_PROXY: 'true',
      }),
      retrieval: emptyRetrieval,
    });

    const [first, second] = await sameSocketDifferentForwardedFor(trusted);
    // Separate buckets: both requests are the first one seen for their own forwarded address.
    expect(second.headers['x-ratelimit-remaining']).toBe(first.headers['x-ratelimit-remaining']);

    await trusted.close();
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
