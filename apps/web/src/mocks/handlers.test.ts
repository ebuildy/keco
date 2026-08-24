import { toDocumentId } from '@keco/core';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from './handlers';

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const search = async (body: Record<string, unknown>) => {
  const response = await fetch('http://localhost:7700/indexes/tools/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

describe('mock handlers', () => {
  it('answers a search with a Meilisearch-shaped response', async () => {
    const { status, body } = await search({ q: '', hitsPerPage: 5, facets: ['kind'] });
    expect(status).toBe(200);
    expect(body.hits).toHaveLength(5);
    expect(body.totalHits).toBeGreaterThan(5);
    expect(body.page).toBe(1);
    expect(Object.keys(body.facetDistribution.kind).length).toBeGreaterThan(0);
    expect(typeof body.processingTimeMs).toBe('number');
  });

  it('answers regardless of which host VITE_MEILI_HOST points at', async () => {
    const response = await fetch('https://meili.example.com/indexes/tools/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '' }),
    });
    expect(response.status).toBe(200);
  });

  it('returns a single document by id', async () => {
    const id = toDocumentId('derailed/k9s');
    const response = await fetch(`http://localhost:7700/indexes/tools/documents/${id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).full_name).toBe('derailed/k9s');
  });

  it('404s an unknown document, so getTool() resolves to null', async () => {
    const response = await fetch('http://localhost:7700/indexes/tools/documents/no__such');
    expect(response.status).toBe(404);
  });

  it('answers a multi-search with one result per query, in order', async () => {
    const response = await fetch('http://localhost:7700/multi-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: [
          { indexUid: 'tools', q: 'gitops', hitsPerPage: 0 },
          { indexUid: 'tools', q: 'zzzzznothing', hitsPerPage: 0 },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results).toHaveLength(2);
    expect(results[0].indexUid).toBe('tools');
    // `hitsPerPage: 0` buys counts and no documents — what verifySuggestions() asks for.
    expect(results[0].hits).toEqual([]);
    expect(results[0].totalHits).toBeGreaterThan(0);
    expect(results[1].totalHits).toBe(0);
  });

  it('404s a multi-search naming an index that does not exist', async () => {
    const response = await fetch('http://localhost:7700/multi-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: [{ indexUid: 'repos_state', q: '' }] }),
    });

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('index_not_found');
  });

  it('serves a README in the shape apps/api returns', async () => {
    const response = await fetch('http://localhost:7700/api/readme/derailed/k9s');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.repo).toBe('derailed/k9s');
    expect(body.html).toContain('<');
    expect(body.truncated).toBe(false);
  });

  it('404s a README that was never cached — an ordinary pre-crawl state', async () => {
    const response = await fetch('http://localhost:7700/api/readme/mockcorp/nothing-here');
    expect(response.status).toBe(404);
  });
});
