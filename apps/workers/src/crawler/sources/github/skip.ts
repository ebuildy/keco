/**
 * Which repos the crawler declines to fetch (AGENTS.md §4.2). Pure: `repo.json` fields in, a
 * reason out — so every rule is provable by a test, which is what §13 asks of a new rule.
 *
 * Decided from repo metadata ALONE, and that is the point: the decision happens after one
 * request and before the three that fetch README, tree and releases. A rule that needed the
 * README would cost the requests it exists to save.
 *
 * `ci-manifest-only` is deliberately NOT here. AGENTS.md §4.2 lists it, but §14 says the
 * opposite for the same repos — "keep them in cache, filter them out at projection time" — and
 * `k8s_relevance` is an analyzer-assigned field. §14 wins: relevance needs the README and tree
 * this decision runs before, and re-deciding it after a rule change must not require a
 * re-crawl. See docs/superpowers/specs/2026-09-05-crawler-design.md §10.2.
 */

/**
 * A fork below this is noise. Above it, AGENTS.md says "and diverged" — which needs a compare
 * API call per fork, a request spent to decide whether to spend requests, on the cheapest
 * category of repo in the corpus. The star threshold is the approximation; see the spec §10.3.
 */
export const FORK_STAR_FLOOR = 200;

/** An archived repo this famous is still worth indexing, however long it has been still. */
export const ARCHIVED_STAR_FLOOR = 1000;

export const STALE_MONTHS = 24;

export type SkipInput = {
  fork: boolean;
  archived: boolean;
  stars: number;
  /** `null` when GitHub reports no push at all — treated as maximally stale. */
  pushed_at: string | null;
};

export type SkipDecision = { reason: string } | null;

export function decideSkip(input: SkipInput, now: Date): SkipDecision {
  // Fork first: it is the cheaper truth, and a repo that is both wants the reason that
  // explains why nobody should look at it rather than the one about its age.
  if (input.fork && input.stars <= FORK_STAR_FLOOR) return { reason: 'fork' };

  if (input.archived && input.stars <= ARCHIVED_STAR_FLOOR && isStale(input.pushed_at, now)) {
    return { reason: 'archived-stale' };
  }

  return null;
}

function isStale(pushedAt: string | null, now: Date): boolean {
  if (pushedAt === null) return true;
  const pushed = new Date(pushedAt);
  if (Number.isNaN(pushed.getTime())) return true;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - STALE_MONTHS);
  return pushed < cutoff;
}
