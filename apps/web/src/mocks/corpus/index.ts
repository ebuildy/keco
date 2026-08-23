import type { ToolDocument } from '@keco/core';
import { CURATED } from './curated';
import { generateTools } from './generate';

/**
 * Mock fixture data — development and test only. See the governing invariant in
 * docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md: this must never reach a
 * production build, and `apps/web/scripts/assert-no-mocks.ts` verifies that it does not.
 */

/**
 * A distinctive string that exists nowhere else in the codebase, so scanning a built `dist/`
 * for it is a reliable signal. Deliberately not something short like "msw", which occurs by
 * chance in minified output — a guard that false-positives is a guard someone switches off.
 */
export const MOCK_SENTINEL = 'KECO_MOCK_CORPUS_DO_NOT_SHIP';

const TARGET_SIZE = 300;

export const MOCK_CORPUS: ToolDocument[] = [
  ...CURATED,
  ...generateTools(Math.max(0, TARGET_SIZE - CURATED.length)),
];
