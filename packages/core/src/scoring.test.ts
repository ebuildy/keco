import { describe, expect, it } from 'vitest';
import { ARCHIVED_TOTAL_CAP, popularity, quality, total } from './scoring';

describe('popularity', () => {
  it('compresses the star long tail', () => {
    expect(popularity(0)).toBe(0);
    expect(popularity(100_000 - 1)).toBeCloseTo(1, 2);
    // 100 stars is worth well over a tenth of 100k — that is the point of the log.
    expect(popularity(100)).toBeGreaterThan(0.4);
  });

  it('never exceeds 1 for absurd star counts', () => {
    expect(popularity(2_000_000)).toBe(1);
  });
});

describe('quality', () => {
  it('renormalises over available signals instead of penalising absence', () => {
    const withScorecard = quality({
      hasLicense: true,
      hasReleases: true,
      hasDocs: true,
      archived: false,
      scorecardCodeReview: 10,
      scorecardCiTests: 10,
      scorecardSignedReleases: 10,
      scorecardBranchProtection: 10,
    });
    const withoutScorecard = quality({
      hasLicense: true,
      hasReleases: true,
      hasDocs: true,
      archived: false,
    });

    // A repo OpenSSF never scanned is not worse — it is less covered.
    expect(withoutScorecard.score).toBeCloseTo(withScorecard.score, 5);
    expect(withoutScorecard.coverage).toBeLessThan(withScorecard.coverage);
    expect(withScorecard.coverage).toBeCloseTo(1, 2);
  });

  it('reports zero coverage when nothing is known', () => {
    expect(quality({})).toEqual({ score: 0, coverage: 0 });
  });

  it('subtracts open vulnerabilities', () => {
    const clean = quality({ hasLicense: true, openVulns: 0 });
    const vulnerable = quality({ hasLicense: true, openVulns: 5 });
    expect(vulnerable.score).toBeLessThan(clean.score);
  });
});

describe('total', () => {
  const perfect = { popularity: 1, activity: 1, adoption: 1, quality: 1 };

  it('caps archived projects however famous they are', () => {
    expect(total(perfect, true)).toBe(ARCHIVED_TOTAL_CAP);
  });

  it('ranks a healthy small project above a dead famous one', () => {
    const deadFamous = total({ popularity: 1, activity: 0.05, adoption: 0.6, quality: 0.3 }, false);
    const healthySmall = total({ popularity: 0.55, activity: 0.95, adoption: 0.5, quality: 0.9 }, false);
    expect(healthySmall).toBeGreaterThan(deadFamous);
  });
});
