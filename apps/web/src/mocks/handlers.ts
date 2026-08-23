import { TOOLS_INDEX } from '@keco/core';
import { http, HttpResponse } from 'msw';
import { MOCK_CORPUS } from './corpus/index';
import { runSearch, type MockSearchRequest } from './engine';
import { MOCK_READMES } from './readmes';

/**
 * Mock request handlers — development and test only.
 *
 * Imports isomorphic `msw` only, never `msw/browser`: that keeps this module loadable in the
 * node test environment through setupServer, which is how handlers.test.ts covers the URL
 * patterns as well as the responses. `browser.ts` owns the browser-only import.
 *
 * Patterns are host-wildcarded (each begins with a bare `*`) so interception works whatever
 * VITE_MEILI_HOST is set to, without this module reading Vite's env.
 */
export const handlers = [
  http.post(`*/indexes/${TOOLS_INDEX}/search`, async ({ request }) => {
    const body = (await request.json()) as MockSearchRequest;
    return HttpResponse.json(runSearch(MOCK_CORPUS, body));
  }),

  http.get(`*/indexes/${TOOLS_INDEX}/documents/:id`, ({ params }) => {
    const tool = MOCK_CORPUS.find((candidate) => candidate.id === params.id);
    if (!tool) {
      // The shape meilisearch-js turns into a MeilisearchApiError, which getTool() catches.
      return HttpResponse.json(
        { message: `Document \`${String(params.id)}\` not found.`, code: 'document_not_found', type: 'invalid_request', link: '' },
        { status: 404 },
      );
    }
    return HttpResponse.json(tool);
  }),

  http.get('*/api/readme/:owner/:repo', ({ params }) => {
    const fullName = `${String(params.owner)}/${String(params.repo)}`;
    const readme = MOCK_READMES[fullName];
    if (!readme) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({ repo: fullName, html: readme.html, truncated: readme.truncated });
  }),
];
