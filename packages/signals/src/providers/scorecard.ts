import type { Cache } from '@keco/cache';
import { z } from 'zod';
import { DAY, Provider } from '../provider';

/**
 * OpenSSF Scorecard. Coverage is partial by design — OpenSSF only scans its weekly cron
 * set, so most niche repos have no score at all. Absence is *unknown* and renormalises
 * the quality axis; it is never a zero (AGENTS.md §4.2, §4.3, §14).
 */
export const ScorecardResponse = z.object({
  date: z.string(),
  score: z.number(),
  checks: z.array(
    z.object({
      name: z.string(),
      score: z.number(),
      reason: z.string().optional(),
    }),
  ),
});
export type ScorecardResponse = z.infer<typeof ScorecardResponse>;

/** The checks that feed the quality axis (§4.3). */
export const QUALITY_CHECKS = [
  'Code-Review',
  'CI-Tests',
  'Signed-Releases',
  'Branch-Protection',
  'Maintained',
  'Vulnerabilities',
  'Dangerous-Workflow',
] as const;

export const scorecardProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'scorecard',
      ttlSeconds: 7 * DAY,
      timeoutMs: 8_000,
      schema: ScorecardResponse,
      // key is `owner/repo`
      request: (key) => ({
        url: `https://api.securityscorecards.dev/projects/github.com/${key}`,
        init: { headers: { accept: 'application/json' } },
      }),
    },
    cache,
  );

export const checkScores = (response: ScorecardResponse): Record<string, number> =>
  Object.fromEntries(response.checks.map((check) => [check.name, check.score]));
