import { parseArgs } from 'node:util';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';

/**
 * analyzer — `RepoFetched` where `changed` → `analysis/**` + `RepoAnalyzed` (§4.2).
 *
 * Three passes over each repo, cheapest first: local rules settle most of it, external
 * providers add what GitHub metadata cannot tell you, and the LLM only sees what is left
 * ambiguous. Every external call goes through the TTL cache in `external/`, which is what
 * makes a replay after a rule, prompt or taxonomy change nearly free.
 *
 * It reads the journal and its own checkpoint — never Meilisearch. An analyzer that
 * queries a read model to decide what to work on has broken the pattern (§2.1, §14).
 */
const log = workerLogger('analyzer');

const { values } = parseArgs({
  options: {
    'force-refresh': { type: 'string' }, // provider name — the only TTL bypass, and it is manual
    repo: { type: 'string' },
    'min-confidence': { type: 'string' },
  },
  allowPositionals: true,
});

async function main(): Promise<void> {
  const { journal } = createRuntime();
  const checkpoint = await journal.checkpoint('analyzer');
  log.info({ checkpoint: checkpoint.last_event_id, forceRefresh: values['force-refresh'] }, 'analyzer start');

  let seen = 0;
  let lastId = checkpoint.last_event_id;

  for await (const event of journal.read({ afterId: checkpoint.last_event_id })) {
    lastId = event.id;
    if (event.type !== 'RepoFetched' || !event.changed) continue;
    seen += 1;
    log.debug({ repo: event.repo, content_hash: event.content_hash }, 'would analyze');

    // TODO(analyzer): implement the three passes (§4.2):
    //   pass 1 — classifyKind / classifyDomains / k8sRelevance / classifyRuntime /
    //            classifyDerived over the cached payloads. classifyDerived takes the
    //            repo.json licence, timestamps and owner type, plus the CNCF landscape
    //            lookup — pass `landscape: null` until the crawler caches that seed, which
    //            degrades maturity and governance to `unknown` rather than guessing.
    //   pass 2 — signal providers via @keco/signals; a provider that fails yields null +
    //            an entry in partial_signals[]; write the analysis anyway with partial:true
    //   pass 3 — LLM only when confidence < 0.7 or kind is ambiguous, structured output
    //            validated by AnalysisSchema, one retry, then fallbackAnalysis()
    //   Then run the assembled document through AnalysisSchema.parse() — exactly as
    //   fallbackAnalysis() already does for pass 3 — before writing analysis/{repo}.json
    //   and appending RepoAnalyzed. §3 calls this path "schema-validated" and it has to
    //   actually be: the taxonomy is data, so a mistyped family value is not a type error
    //   and nothing downstream would reject it.
    // Also re-analyze when the oldest signal's TTL has expired, not only on a content_hash
    // change — signal freshness drifts from repo freshness (§14).
    // NOTE: AnalysisSchema defaults the five taxonomy fields to `unknown`, so an
    // analysis written before those families existed stays parseable on replay — but it
    // also stays `unknown` forever, because an unchanged content_hash never re-triggers
    // analysis. Re-classification is not driven by content_hash alone (§14). When these
    // passes land, force one full-corpus pass-1 re-run for the new fields rather than
    // waiting for organic change: it is free, being rules over data already in cache.
  }

  if (lastId && lastId !== checkpoint.last_event_id) {
    // Advance only once the work above is durable in the cache.
    log.info({ candidates: seen, checkpoint: lastId }, 'analyzer batch complete (dry run — not advancing)');
  } else {
    log.info({ candidates: seen }, 'nothing to analyze');
  }

  log.warn('analyzer passes are not implemented yet — see the TODO in this file and AGENTS.md §4.2');
}

await main();
