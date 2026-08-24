import { TOOLS_INDEX } from '@keco/core';
import { http, HttpResponse } from 'msw';
import { MOCK_CORPUS } from './corpus/index';
import { runSearch, type MockSearchRequest } from './engine';
import { MOCK_READMES } from './readmes';

/** One entry of a `POST /multi-search` body: a search request that names its own index. */
type MockMultiSearchQuery = MockSearchRequest & { indexUid: string };

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

  /**
   * `POST /multi-search` — one round trip, several queries. `verifySuggestions()` is the only
   * caller: it proves each "did you mean" candidate returns hits before the zero-result state
   * offers it, so without this handler that path fails silently and the suggestions never
   * render (loudly, since `onUnhandledRequest: 'error'`, but only in the console).
   *
   * An unknown index is answered the way Meilisearch answers it — 404 `index_not_found` for
   * the whole request, not an empty result set. A mock that quietly returns zero hits for a
   * typo'd index name would turn a bug into a plausible-looking answer.
   */
  http.post('*/multi-search', async ({ request }) => {
    const body = (await request.json()) as { queries?: MockMultiSearchQuery[] };
    const queries = body.queries ?? [];

    const unknown = queries.find((query) => query.indexUid !== TOOLS_INDEX);
    if (unknown) {
      return HttpResponse.json(
        {
          message: `Index \`${unknown.indexUid}\` not found.`,
          code: 'index_not_found',
          type: 'invalid_request',
          link: '',
        },
        { status: 404 },
      );
    }

    return HttpResponse.json({
      results: queries.map(({ indexUid, ...query }) => ({
        indexUid,
        ...runSearch(MOCK_CORPUS, query),
      })),
    });
  }),

  http.get('*/api/readme/:owner/:repo', ({ params }) => {
    const fullName = `${String(params.owner)}/${String(params.repo)}`;
    const readme = MOCK_READMES[fullName];
    if (!readme) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({ repo: fullName, html: readme.html, truncated: readme.truncated });
  }),
];
