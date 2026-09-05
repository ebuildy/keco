import { z } from 'zod';
import type { Created, Window } from '../windows';
import type { FailedWindow } from './collections';

/**
 * Validation for everything read back out of a DataStore (AGENTS.md §13). A document can have
 * been written by an older version of this code, hand-edited in the fs store, or truncated by
 * something outside this process — the store degrades rather than throwing, and these schemas
 * are what let it tell the difference between "resumable" and "start over".
 */

/**
 * Structural mirrors of `windows.ts`'s types. The `z.ZodType<…>` annotations are load-bearing:
 * add a `Created` variant or a `Window` field and this file fails to compile until the schema
 * catches up, rather than silently rejecting real windows at runtime.
 */
const CreatedSchema: z.ZodType<Created> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('years'), from: z.number(), to: z.number() }),
  z.object({ kind: z.literal('year'), year: z.number() }),
  z.object({ kind: z.literal('quarter'), year: z.number(), quarter: z.number() }),
  z.object({ kind: z.literal('month'), year: z.number(), month: z.number() }),
  z.object({ kind: z.literal('day'), date: z.string() }),
]);

const WindowSchema: z.ZodType<Window> = z.object({
  base: z.string(),
  stars: z.string(),
  created: CreatedSchema.nullable(),
});

const FailedWindowSchema: z.ZodType<FailedWindow> = z.object({
  window: z.string(),
  error: z.string(),
});

export const StateDocumentSchema = z.object({
  query_slug: z.string(),
  query: z.string(),
  started_at: z.string(),
  updated_at: z.string().default(''),
  current_run_id: z.string().default(''),
  pending_windows: z.array(WindowSchema),
  completed_windows: z.array(z.string()),
  failed_windows: z.array(FailedWindowSchema),
  repos_seen: z.number(),
  pages_fetched: z.number(),
  // `.default(0)`, not required: a counter added after the fact must not invalidate a state
  // document mid-sweep. zod backfills it, so an older document resumes instead of being
  // rejected and degraded to a full resweep.
  dropped: z.number().default(0),
});

export type StateDocument = z.infer<typeof StateDocumentSchema>;

/**
 * The projection the resume path reads — three fields out of a repo document, because
 * streaming 31k full documents to rebuild a hash map is the one avoidable cost at startup.
 */
export const KnownRepoSchema = z.object({
  repo_id: z.number(),
  payload_hash: z.string(),
  first_seen_run_id: z.string().default(''),
});

export type KnownRepo = z.infer<typeof KnownRepoSchema>;
