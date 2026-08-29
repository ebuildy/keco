import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolDocument } from '@keco/core';
import { MOCK_CORPUS, MOCK_SENTINEL } from '../src/mocks/corpus';

/**
 * Emits the portal's mock corpus as a plain JSON array at `infra/mock/corpus.json`, so the
 * write side can seed a real Meilisearch with it without importing anything from `apps/web`.
 *
 * The corpus stays declared once, in TypeScript, where `makeTool` keeps every document
 * schema-valid and the generator keeps it deterministic. JSON is only the interchange format:
 * `apps/workers` may not import a browser bundle's fixtures (§7), and `apps/web` may not
 * import `@keco/search` (§7 again), so a file on disk is the only seam the two share.
 *
 * The output is byte-stable — `generate.ts` is seeded, `curated.ts` is hand-written, and this
 * file adds no timestamp — so the artifact is committed and `emit-mock-corpus.test.ts` fails
 * the build if it ever drifts from the generator.
 *
 * Development and test only, like everything else under `src/mocks`: every document carries
 * `MOCK_SENTINEL` in `discovery_source`, and the seeder refuses a corpus where one does not.
 */

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CORPUS_JSON_PATH = resolve(WORKSPACE_ROOT, 'infra/mock/corpus.json');

/**
 * Validates before it writes. `MOCK_CORPUS` is typed as `ToolDocument[]`, but the taxonomy is
 * data (§6) — `kind` and the five family fields are plain `string`, so a fixture naming a
 * value that `taxonomy.yaml` does not declare is not a type error. Parsing here is what turns
 * that into a failed build rather than 300 documents Meilisearch accepts and no chip matches.
 */
export function serialiseCorpus(documents: readonly unknown[]): string {
  const parsed = documents.map((document, index) => {
    const result = ToolDocument.safeParse(document);
    if (!result.success) {
      throw new Error(`mock corpus document ${index} is not a valid ToolDocument: ${result.error.message}`);
    }
    return result.data;
  });

  const strays = parsed.filter((document) => document.discovery_source !== MOCK_SENTINEL);
  if (strays.length > 0) {
    throw new Error(
      `mock corpus documents must carry the sentinel in discovery_source: ${strays
        .map((document) => document.full_name)
        .join(', ')}`,
    );
  }

  // A plain JSON array — `JSON.parse` on the whole file, no NDJSON reader anywhere — but with
  // one compact document per line rather than an indented tree. Fully indented, 300 documents
  // is ~600 KB and a one-field change rewrites hundreds of lines; this way a diff is one line
  // per document that actually changed, which is what makes the artifact reviewable in a PR.
  return `[\n${parsed.map((document) => JSON.stringify(document)).join(',\n')}\n]\n`;
}

/** The bytes the committed artifact must equal. Used by the emitter and by its drift test. */
export const expectedCorpusJson = (): string => serialiseCorpus(MOCK_CORPUS);

/** The bytes currently on disk, or null when the artifact has never been emitted. */
export function readCorpusJson(): string | null {
  try {
    return readFileSync(CORPUS_JSON_PATH, 'utf8');
  } catch {
    return null;
  }
}

const invokedDirectly = process.argv[1]?.endsWith('emit-mock-corpus.ts') ?? false;
if (invokedDirectly) {
  const json = expectedCorpusJson();
  mkdirSync(dirname(CORPUS_JSON_PATH), { recursive: true });
  writeFileSync(CORPUS_JSON_PATH, json);
  const where = relative(WORKSPACE_ROOT, CORPUS_JSON_PATH);
  console.info(`✓ wrote ${MOCK_CORPUS.length} mock documents to ${where} (${json.length} bytes)`);
}
