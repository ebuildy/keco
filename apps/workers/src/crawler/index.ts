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

export type CrawlOptions = {
  seeds: string[];
  limit: number;
  /** Crawl a single repo instead of the seed lists. `null` means the full run. */
  repo: string | null;
};

export async function runCrawler({ seeds, limit, repo }: CrawlOptions): Promise<void> {
  const { journal } = createRuntime();

  log.info(
    { seeds, limit, repo, checkpoint: 'n/a — the crawler is driven by seeds, not a checkpoint' },
    'crawler start',
  );

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
  //   5. icons — call updateIcon() from ./icon with the repo.json, tree.json and readme.md
  //      just written (docs/superpowers/specs/2026-08-24-project-icons-design.md §2.3). It
  //      never throws: a repo with no usable icon records why in icon.json and the crawl
  //      carries on. Icon bytes are deliberately NOT part of contentHash() — a logo that
  //      moves changes tree.json and so changes the hash already, and folding the bytes in
  //      would invalidate the whole corpus for a cosmetic field.
  //      Until this loop exists, `mise run repo:icon -- --repo owner/name` runs the same
  //      pipeline
  //      for one repo.
  //   Honour x-ratelimit-remaining and back off on 403/429 — a crawl that gets the token
  //   throttled is a failed crawl.
  void ownsShard;
  void config;
  void journal;
  void repo;

  log.warn('crawler is not implemented yet — see the TODO in this file and AGENTS.md §4.1');
}
