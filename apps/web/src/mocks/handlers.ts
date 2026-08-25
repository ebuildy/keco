import { ICON_SIZES, TOOLS_INDEX } from '@keco/core';
import { http, HttpResponse } from 'msw';
import { MOCK_CORPUS } from './corpus/index';
import { runSearch, type MockSearchRequest } from './engine';
import { decodeIcon, MOCK_REAL_ICONS } from './icons';
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
/**
 * One fixture whose document carries an icon descriptor but whose bytes are not in the cache.
 *
 * Not an oddity — it is the ordinary consequence of §2.7. The projector writes a document as
 * soon as an analysis lands; the icon bytes arrive on the crawler's own schedule, so between
 * the two there is a window where the descriptor is real and the PNG is a 404. The portal has
 * to degrade to a monogram there rather than show a broken image, and that is only testable
 * if the mock reproduces the state.
 */
export const ICON_BYTES_MISSING = 'ahmetb/kubectx';

/** A real 1x1 PNG in the accent blue, which the browser scales into a solid placeholder tile. */
const MOCK_ICON_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwynn6HwAE2gKDj5MdkgAAAABJRU5ErkJggg==',
  ),
  (character) => character.charCodeAt(0),
);

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

  /**
   * Mirrors `apps/api`'s icon route, including its refusals — a mock that answered 200 to a
   * size the real route rejects would hide the bug rather than surface it.
   *
   * The bytes are a flat square, deliberately not a fabricated *logo*: the portal's contract
   * is that an icon is the project's own mark, and a mock that invented plausible artwork
   * would teach the wrong thing to anyone reading it.
   */
  http.get('*/api/icon/:owner/:repo/:size.png', ({ params }) => {
    const fullName = `${String(params.owner)}/${String(params.repo)}`;
    const size = String(params.size);
    if (!ICON_SIZES.map(String).includes(size)) return new HttpResponse(null, { status: 400 });

    const tool = MOCK_CORPUS.find((candidate) => candidate.full_name === fullName);
    if (!tool || tool.icon === null) return new HttpResponse(null, { status: 404 });
    // Descriptor projected, bytes not yet crawled — see ICON_BYTES_MISSING above.
    if (fullName === ICON_BYTES_MISSING) return new HttpResponse(null, { status: 404 });

    // Two fixtures carry their real artwork (see ./icons); the rest get the flat placeholder.
    const real = MOCK_REAL_ICONS[fullName]?.[Number(size)];
    return new HttpResponse(real === undefined ? MOCK_ICON_PNG : decodeIcon(real), {
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
    });
  }),

  http.get('*/api/readme/:owner/:repo', ({ params }) => {
    const fullName = `${String(params.owner)}/${String(params.repo)}`;
    const readme = MOCK_READMES[fullName];
    if (!readme) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({ repo: fullName, html: readme.html, truncated: readme.truncated });
  }),
];
