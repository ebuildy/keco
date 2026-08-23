import type { ToolDocument } from '@keco/core';
import { CURATED } from './curated';
import { generateTools } from './generate';

/**
 * Mock fixture data — development and test only. See the governing invariant in
 * docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md: this must never reach a
 * production build, and `apps/web/scripts/assert-no-mocks.ts` verifies that it does not.
 */

/**
 * Re-exported from `./builder`, which declares it (see the comment there for why it lives on
 * every document's `discovery_source` rather than as a bare constant). Declaring it here
 * instead and importing it into `builder.ts` would be a cycle: this module imports `curated.ts`
 * and `generate.ts`, and both of those import `builder.ts`.
 */
export { MOCK_SENTINEL } from './builder';

const TARGET_SIZE = 300;

export const MOCK_CORPUS: ToolDocument[] = [
  ...CURATED,
  ...generateTools(Math.max(0, TARGET_SIZE - CURATED.length)),
];
