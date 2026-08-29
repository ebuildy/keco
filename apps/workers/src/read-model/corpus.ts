import { readFile } from 'node:fs/promises';
import { resolveCacheDir } from '@keco/cache';
import { ToolDocument } from '@keco/core';

/**
 * The portal's mock corpus, read from the JSON artifact `apps/web` emits.
 *
 * Fabricated repos, scores and install commands — development and test only (AGENTS.md §14).
 * Nothing in the pipeline reads this; `src/read-model/**` is operator tooling that lives beside
 * the workers because writing to Meilisearch is a write-side act.
 */

/**
 * A literal copy of the sentinel `apps/web/src/mocks/corpus/builder.ts` declares and stamps
 * into every document's `discovery_source`. Copied rather than imported because `apps/workers`
 * may not import a browser bundle's fixtures (§7) — the same reason
 * `apps/web/scripts/assert-no-mocks.ts` carries its own copy. `emit-mock-corpus.ts` writes the
 * sentinel and this module verifies it, so a drift between the two copies fails the seed run
 * immediately rather than silently disabling the check.
 */
export const MOCK_SENTINEL = 'KECO_MOCK_CORPUS_DO_NOT_SHIP';

/**
 * `resolveCacheDir` is `@keco/cache`'s workspace-root resolver — it walks up to
 * `pnpm-workspace.yaml` — so this path is the same whether the task runs from the repo root or
 * from `apps/workers`. Reusing it beats a second copy of the walk; it is not cache access.
 */
export const MOCK_CORPUS_PATH = resolveCacheDir('infra/mock/corpus.json');

/**
 * Validates every document against `ToolDocument` before it can reach an index — the same rule
 * the projector follows (§4.4): the taxonomy is data, so `governance: 'vendor_backed'` is not a
 * type error, and Meilisearch would accept it happily while no chip ever matched it.
 */
export function parseCorpus(json: string): ToolDocument[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) {
    throw new Error(`mock corpus must be a JSON array of ToolDocuments, got ${typeof raw}`);
  }

  return raw.map((entry, index) => {
    const result = ToolDocument.safeParse(entry);
    if (!result.success) {
      throw new Error(`mock corpus document ${index} is not a valid ToolDocument: ${result.error.message}`);
    }
    if (result.data.discovery_source !== MOCK_SENTINEL) {
      throw new Error(
        `mock corpus document ${index} (${result.data.full_name}) does not carry the mock sentinel — ` +
          'this seeder writes fixtures only; real documents are the projector\'s job (§4.4)',
      );
    }
    return result.data;
  });
}

export async function loadCorpus(path = MOCK_CORPUS_PATH): Promise<ToolDocument[]> {
  const json = await readFile(path, 'utf8').catch(() => {
    throw new Error(`no mock corpus at ${path} — run \`mise run mock:corpus\` to emit it`);
  });
  return parseCorpus(json);
}
