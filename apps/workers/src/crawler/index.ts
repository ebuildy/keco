import { parseArgs } from 'node:util';
import { ownsShard } from '@keco/github';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';

/**
 * crawler — seeds + `RepoDiscovered` → `repos/**` + `RepoFetched` (AGENTS.md §4.1).
 *
 * GitHub Search returns at most 1000 results per query at ~30 authenticated req/min, so
 * discovery is sharded by stars/created windows *and* seeded from registries (CNCF
 * landscape, krew index, Artifact Hub, OperatorHub, curated awesome-* lists), which are
 * higher signal than keyword search.
 *
 * Everything fetched is written to the cache verbatim. ETag / If-None-Match on every
 * request: a 304 costs no quota and short-circuits to RepoFetched{changed:false}.
 */
const log = workerLogger('crawler');

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: 'cncf,krew' },
    limit: { type: 'string', default: '200' },
    repo: { type: 'string' },
  },
  allowPositionals: true,
});

async function main(): Promise<void> {
  const { journal } = createRuntime();
  const seeds = values.seed!.split(',').filter(Boolean);
  const limit = Number(values.limit);

  log.info({ seeds, limit, checkpoint: 'n/a — the crawler is driven by seeds, not a checkpoint' }, 'crawler start');

  // TODO(crawler): implement, in this order (§4.1):
  //   1. discovery — registry seeds first, then sharded GitHub Search queries;
  //      emit RepoDiscovered for each new owner/repo, skipping ones we already know.
  //   2. skip rules — forks (unless >200 stars and diverged), archived + stale >24 months
  //      (unless >1000 stars), Kubernetes-only-in-CI-manifest. Emit RepoSkipped with a
  //      reason; never drop silently.
  //   3. fetch — GraphQL for bulk metadata (<=100 repos/query), REST for README, tree and
  //      releases, always conditional on the stored ETag.
  //   4. write repo.json / readme.md / readme.json / tree.json / releases.json / manifests
  //      verbatim, compute contentHash(), write _fetch.json, emit RepoFetched.
  //   Honour x-ratelimit-remaining and back off on 403/429 — a crawl that gets the token
  //   throttled is a failed crawl.
  void ownsShard;
  void config;
  void journal;

  log.warn('crawler is not implemented yet — see the TODO in this file and AGENTS.md §4.1');
}

await main();
