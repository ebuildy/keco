import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Byte-loading for the taxonomy file, and the only `node:*` code in @keco/core.
 *
 * It lives in its own module so that `package.json`'s `browser` field can swap it for
 * `taxonomy-source.browser.ts` in a bundle (AGENTS.md §7: a frontend importing `node:*` is a
 * build-time bug). Everything that gives the taxonomy meaning — the YAML parse, the zod
 * validation, the freezing, the accessors — stays in `taxonomy.ts` and is shared by both
 * builds, so the two environments cannot disagree about what the vocabulary is.
 */
const FILENAME = 'taxonomy.yaml';

/**
 * Resolves `packages/core/taxonomy.yaml` relative to this module's own location. Not
 * exported: callers get `readTaxonomySource()`, which is the part that has a browser
 * counterpart.
 */
function taxonomyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', FILENAME);
}

/**
 * Reads the taxonomy file at `path` (default: `taxonomyPath()`). The `path` parameter exists
 * so the not-found branch is reachable from a test without a filesystem mocking layer — by
 * the time any other test runs, module load has already succeeded once, so that branch would
 * otherwise be untestable.
 *
 * Node-only. The browser module has no counterpart for it, because there is no path to miss.
 */
export function readTaxonomyFile(path: string = taxonomyPath()): string {
  if (!existsSync(path)) {
    throw new Error(`taxonomy: ${FILENAME} not found. Looked in:\n  ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/** The one function `taxonomy.ts` calls, and the one the browser module also provides. */
export const readTaxonomySource = (): string => readTaxonomyFile();
