import type { Score } from './schemas';

/**
 * Ranking (AGENTS.md §4.3). Stars alone rank dead-but-famous repos above healthy new
 * ones — that is the failure mode this is designed against.
 */

export const WEIGHTS = {
  popularity: 0.35,
  activity: 0.3,
  adoption: 0.2,
  quality: 0.15,
} as const;

/** An archived project is capped here however famous it is. */
export const ARCHIVED_TOTAL_CAP = 0.4;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const days = (ms: number): number => ms / 86_400_000;

/** log10(stars + 1) / log10(100000) — compresses the long tail of star counts. */
export function popularity(stars: number): number {
  return clamp01(Math.log10(Math.max(0, stars) + 1) / Math.log10(100_000));
}

/**
 * Recency of pushes, releases and commits, plus Scorecard's Maintained check when we
 * have it. Everything decays; nothing here rewards a single big year-old burst.
 */
export function activity(input: {
  pushedAt: Date;
  lastReleaseAt?: Date | null;
  releasesLast12m?: number;
  scorecardMaintained?: number | null; // 0..10
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  const pushAge = days(now.getTime() - input.pushedAt.getTime());
  // 1.0 fresh today, ~0.5 at 3 months, ~0 past 18 months.
  const push = clamp01(1 - pushAge / 540);

  const releaseAge = input.lastReleaseAt ? days(now.getTime() - input.lastReleaseAt.getTime()) : null;
  const release = releaseAge === null ? 0 : clamp01(1 - releaseAge / 365);
  const cadence = clamp01((input.releasesLast12m ?? 0) / 6);
  const maintained =
    input.scorecardMaintained === null || input.scorecardMaintained === undefined
      ? null
      : clamp01(input.scorecardMaintained / 10);

  const parts: number[] = [push * 0.5, release * 0.2, cadence * 0.15];
  const weightUsed = 0.85;
  if (maintained === null) {
    // Renormalise over what we have rather than scoring an absent signal as zero.
    return clamp01(parts.reduce((a, b) => a + b, 0) / weightUsed);
  }
  return clamp01(parts.reduce((a, b) => a + b, 0) + maintained * 0.15);
}

/** Presence in the registries that prove real use, plus deps.dev dependents. */
export function adoption(input: {
  inKrew?: boolean;
  inBrew?: boolean;
  inArtifactHub?: boolean;
  inCncfLandscape?: boolean;
  dependents?: number | null;
}): number {
  const registries =
    Number(Boolean(input.inKrew)) +
    Number(Boolean(input.inBrew)) +
    Number(Boolean(input.inArtifactHub)) +
    Number(Boolean(input.inCncfLandscape));
  const registryScore = clamp01(registries / 3);
  const dependentsScore =
    input.dependents === null || input.dependents === undefined
      ? 0
      : clamp01(Math.log10(input.dependents + 1) / Math.log10(1000));
  return clamp01(registryScore * 0.7 + dependentsScore * 0.3);
}

export type QualitySignals = {
  hasLicense?: boolean;
  hasReleases?: boolean;
  hasDocs?: boolean;
  archived?: boolean;
  scorecardCodeReview?: number | null;
  scorecardCiTests?: number | null;
  scorecardSignedReleases?: number | null;
  scorecardBranchProtection?: number | null;
  openVulns?: number | null;
};

/**
 * Quality renormalised over the signals that exist (§4.3). Scorecard only covers
 * OpenSSF's weekly cron set, so most niche repos have no score at all: absence is
 * *unknown*, never zero. Scoring a repo badly because a third party never looked at it
 * is a silent, corpus-wide bias.
 *
 * Returns the score and the share of sub-signals that actually backed it.
 */
export function quality(signals: QualitySignals): { score: number; coverage: number } {
  const present: Array<{ value: number; weight: number }> = [];
  const add = (value: number | null | undefined, weight: number, scale = 1) => {
    if (value === null || value === undefined) return;
    present.push({ value: clamp01(Number(value) / scale), weight });
  };

  add(signals.hasLicense === undefined ? undefined : Number(signals.hasLicense), 0.15);
  add(signals.hasReleases === undefined ? undefined : Number(signals.hasReleases), 0.1);
  add(signals.hasDocs === undefined ? undefined : Number(signals.hasDocs), 0.1);
  add(signals.archived === undefined ? undefined : Number(!signals.archived), 0.1);
  add(signals.scorecardCodeReview, 0.15, 10);
  add(signals.scorecardCiTests, 0.15, 10);
  add(signals.scorecardSignedReleases, 0.1, 10);
  add(signals.scorecardBranchProtection, 0.1, 10);

  const TOTAL_WEIGHT = 0.95; // sum of every weight above, for coverage reporting
  const availableWeight = present.reduce((sum, p) => sum + p.weight, 0);
  if (availableWeight === 0) return { score: 0, coverage: 0 };

  const weighted = present.reduce((sum, p) => sum + p.value * p.weight, 0) / availableWeight;

  // Known open vulnerabilities are a subtraction, not a missing-signal problem.
  const vulnPenalty =
    signals.openVulns === null || signals.openVulns === undefined
      ? 0
      : clamp01(signals.openVulns / 10) * 0.3;

  return {
    score: clamp01(weighted - vulnPenalty),
    coverage: clamp01(availableWeight / TOTAL_WEIGHT),
  };
}

/**
 * With no history there is no honest star velocity (§4.3). Stars per day of age, damped
 * by recent activity, surfaces fast-growing young projects without pretending to measure
 * a 30-day delta. Label it "momentum" in the UI — never "trending this week".
 *
 * Z-scoring across the corpus happens in the projector, which sees every repo.
 */
export function rawMomentum(input: { stars: number; createdAt: Date; activity: number; now?: Date }): number {
  const now = input.now ?? new Date();
  const ageDays = Math.max(1, days(now.getTime() - input.createdAt.getTime()));
  return (input.stars / ageDays) * input.activity;
}

export function zScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

export function total(axes: Pick<Score, 'popularity' | 'activity' | 'adoption' | 'quality'>, archived: boolean): number {
  const raw =
    axes.popularity * WEIGHTS.popularity +
    axes.activity * WEIGHTS.activity +
    axes.adoption * WEIGHTS.adoption +
    axes.quality * WEIGHTS.quality;
  return archived ? Math.min(raw, ARCHIVED_TOTAL_CAP) : clamp01(raw);
}
