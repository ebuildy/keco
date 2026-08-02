import { parseArgs } from 'node:util';
import { awaitTask, createAdminClient, TOOLS_ALIAS } from '@keco/search';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';

/**
 * projector — `RepoAnalyzed` → Meilisearch `tools` + `repos_state` (AGENTS.md §4.3).
 *
 * Pure: cache in, index out, no network beyond Meilisearch. It must stay that way — it is
 * the thing you re-run most often, and read-model changes are applied by re-projecting
 * from cache with zero GitHub calls (§15.3).
 *
 * The projector is the only writer to Meilisearch. Nothing else writes to it, ever.
 */
const log = workerLogger('projector');

const { values } = parseArgs({
  options: {
    rebuild: { type: 'boolean', default: false },
    batch: { type: 'string', default: '1000' },
  },
  allowPositionals: true,
});

async function main(): Promise<void> {
  const { journal } = createRuntime();
  const client = createAdminClient();
  const checkpoint = await journal.checkpoint('projector');

  log.info(
    { rebuild: values.rebuild, checkpoint: checkpoint.last_event_id, batchSize: Number(values.batch) },
    'projector start',
  );

  if (values.rebuild) {
    // TODO(projector): full rebuild (§4.3): read every analysis/** from cache, build
    // tools_<ts> via createRebuildIndex(), upsert in batches of <=1000 awaiting each task,
    // verify the document count, then promote() to swap the alias. Keep the previous index
    // for one cycle for instant rollback. Never mutate the live alias.
    log.warn('rebuild is not implemented yet — see AGENTS.md §4.3');
    return;
  }

  let projected = 0;
  let lastId = checkpoint.last_event_id;

  for await (const event of journal.read({ afterId: checkpoint.last_event_id })) {
    lastId = event.id;
    if (event.type !== 'RepoAnalyzed') continue;
    projected += 1;
    log.debug({ repo: event.repo }, 'would project');

    // TODO(projector): read repos/{repo}/repo.json + analysis/{repo}.json, compute the
    // four score axes plus momentum (z-scored across the corpus), build the ToolDocument,
    // and buffer it. Copy kind, domains, runtime, license_class, openness, maturity and
    // governance straight from the analysis — the projector classifies nothing, it only
    // scores. Send complete sub-objects: updateDocuments merges only at the top level, so
    // a partial `score` wipes the rest of it (§5, §14).
    //
    // VALIDATE BEFORE YOU UPSERT. Run every document through `ToolDocument.parse()` and, on
    // failure, emit RepoFailed and skip it rather than writing. This is not optional
    // belt-and-braces: the taxonomy is data now, so `kind` and the five family fields are
    // plain `string` and a typo like `'vendor_backed'` is no longer a type error. Nothing
    // downstream would catch it — Meilisearch accepts any value, `searchTools` casts the
    // response to ToolDocument without parsing, and the portal renders it verbatim or
    // silently never matches a chip. The write side is what guarantees read-model
    // correctness (§2); pinning.test.ts only pins the analyzer's rule tables, not this.
  }

  // Meilisearch writes are asynchronous: await the task, THEN advance the checkpoint, or a
  // crash silently loses a batch (§5, §14).
  void awaitTask;
  void client;
  void TOOLS_ALIAS;

  if (projected > 0) {
    log.info({ projected, checkpoint: lastId }, 'projector batch complete (dry run — not advancing)');
  } else {
    log.info({ checkpoint: lastId }, 'nothing to project');
  }

  log.warn('projection is not implemented yet — see the TODO in this file and AGENTS.md §4.3');
}

await main();
