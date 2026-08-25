import { buildFilters, values, type ToolDocument } from '@keco/core';
import { MOCK_CORPUS } from '../src/mocks/corpus/index';
import { ICON_BYTES_MISSING } from '../src/mocks/handlers';
import { runSearch } from '../src/mocks/engine';
import { MOCK_READMES } from '../src/mocks/readmes';

/**
 * Expectations derived from the fixture corpus, not hardcoded.
 *
 * The portal's behaviour is "report what the backend gave you", so an assertion that hardcodes
 * `299` is really asserting the fixture file's current contents — it breaks when someone adds
 * a curated repo, which is a normal thing to do and not a regression. Everything here is
 * computed from the same corpus and the same filter algebra (`buildFilters`) the page itself
 * queries with, so the numbers move together.
 *
 * This module runs in Playwright's Node process, never in the browser, so importing the mock
 * corpus here carries none of the §14 shipping risk that bars it from `src/`.
 */
const publicSearch = (params: Parameters<typeof runSearch>[1] = {}) =>
  runSearch(MOCK_CORPUS, { filter: buildFilters({}), ...params });

/** What the home page's "N repositories classified" must say: archived and low-relevance out. */
export const CORPUS_TOTAL = publicSearch({ hitsPerPage: 0 }).totalHits;

/** The order the home page's "Highest momentum" list must be in. */
export const TOP_MOMENTUM = publicSearch({
  sort: ['score.momentum:desc'],
  hitsPerPage: 12,
}).hits;

export function tool(fullName: string): ToolDocument {
  const found = MOCK_CORPUS.find((candidate) => candidate.full_name === fullName);
  if (!found) throw new Error(`e2e/corpus.ts: ${fullName} is not in the mock corpus`);
  return found;
}

/**
 * A fixture with neither a verified install method nor a cached README — the corpus's example
 * of the two "nothing to show, so say so" states on the tool page.
 *
 * Picked by rule rather than named. Which document this lands on depends on the corpus, and a
 * test that hardcoded one would start asserting the fixture file rather than the behaviour the
 * moment somebody adds a `brew` entry to it.
 */
export const BARE_TOOL: ToolDocument = (() => {
  const found = publicSearch({ hitsPerPage: 1000 }).hits.find(
    (candidate) =>
      candidate.install_methods.length === 0 && MOCK_READMES[candidate.full_name] === undefined,
  );
  if (!found) throw new Error('e2e/corpus.ts: no fixture without install methods and README');
  return found;
})();

/**
 * A fixture the analyzer could not place — `runtime: unknown`, which §6 hides from the UI.
 *
 * Picked by rule, like `BARE_TOOL`: which generated document carries it depends on the corpus,
 * and the behaviour under test is "a hidden value renders no chip", not "document N is the
 * unclassified one".
 */
export const UNKNOWN_RUNTIME: ToolDocument = (() => {
  const found = publicSearch({ hitsPerPage: 1000 }).hits.find(
    (candidate) => candidate.runtime === 'unknown',
  );
  if (!found) throw new Error('e2e/corpus.ts: no fixture with an unknown runtime');
  return found;
})();

/**
 * A fixture with an icon, and one without — picked by rule rather than named, like
 * `BARE_TOOL`. Which documents these land on depends on the corpus, and a test that hardcoded
 * one would start asserting the fixture file the moment somebody added an icon to it.
 */
export const WITH_ICON: ToolDocument = (() => {
  const found = publicSearch({ hitsPerPage: 1000 }).hits.find(
    (candidate) => candidate.icon !== null && candidate.full_name !== ICON_BYTES_MISSING,
  );
  if (!found) throw new Error('e2e/corpus.ts: no fixture with an icon');
  return found;
})();

/**
 * The document carries an icon descriptor but the cache has no bytes for it — the window §2.7
 * opens between the projector writing a document and the crawler fetching its artwork. The
 * portal must show a monogram here, not a broken image.
 */
export const PENDING_ICON: ToolDocument = tool(ICON_BYTES_MISSING);

export const ICONLESS: ToolDocument = (() => {
  const found = publicSearch({ hitsPerPage: 1000 }).hits.find((candidate) => candidate.icon === null);
  if (!found) throw new Error('e2e/corpus.ts: no fixture without an icon');
  return found;
})();

/**
 * The taxonomy's label for a value — what the tool page must render instead of the id (§6).
 * Read from the vocabulary rather than from `src/lib/tool-taxonomy.ts`, so the assertion is
 * against the declared label and not against the code that renders it.
 */
export function label(familyId: string, valueId: string): string {
  const found = values(familyId).find((value) => value.id === valueId);
  if (!found) throw new Error(`e2e/corpus.ts: ${familyId}:${valueId} is not a visible value`);
  return found.label;
}

/** Curated repos, referenced by name because they are hand-written and stable. */
export const K9S = tool('derailed/k9s');
/** Two verified install methods — brew and krew — so the tablist has something to switch. */
export const KUBECTX = tool('ahmetb/kubectx');
/** Archived: reachable by direct link, filtered out of search (`buildFilters` drops it). */
export const ARCHIVED = tool('datreeio/datree');
