import { z } from 'zod';

/**
 * The journal (AGENTS.md §3). Append-only, ULID-keyed so consumers resume from an
 * offset. Events are facts about the past: never edited, never deleted. Replay is
 * normal operation — reset a checkpoint and everything downstream rebuilds.
 */

/** `owner/repo`, the only public identifier in the system. */
export const RepoRef = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'expected owner/repo');
export type RepoRef = z.infer<typeof RepoRef>;

const base = {
  id: z.string(), // ULID — lexicographically sortable, doubles as the cache key
  ts: z.iso.datetime(),
};

export const RepoDiscovered = z.object({
  ...base,
  type: z.literal('RepoDiscovered'),
  repo: RepoRef,
  source: z.string(), // cncf-landscape | krew | artifacthub | search:topic:kubernetes | …
});

export const RepoFetched = z.object({
  ...base,
  type: z.literal('RepoFetched'),
  repo: RepoRef,
  content_hash: z.string(),
  changed: z.boolean(),
});

export const RepoAnalyzed = z.object({
  ...base,
  type: z.literal('RepoAnalyzed'),
  repo: RepoRef,
  content_hash: z.string(),
  confidence: z.number().min(0).max(1),
  partial: z.boolean().default(false),
});

export const RepoSkipped = z.object({
  ...base,
  type: z.literal('RepoSkipped'),
  repo: RepoRef,
  reason: z.string(), // fork | archived-stale | ci-manifest-only | not-k8s | …
});

export const RepoFailed = z.object({
  ...base,
  type: z.literal('RepoFailed'),
  repo: RepoRef,
  phase: z.enum(['crawl', 'analyze', 'project']),
  error: z.string(),
});

export const Event = z.discriminatedUnion('type', [
  RepoDiscovered,
  RepoFetched,
  RepoAnalyzed,
  RepoSkipped,
  RepoFailed,
]);

export type Event = z.infer<typeof Event>;
export type EventType = Event['type'];

/** Payload as authored by a worker; `id` and `ts` are stamped on append. */
export type NewEvent = {
  [T in EventType]: Omit<Extract<Event, { type: T }>, 'id' | 'ts'>;
}[EventType];

/** One checkpoint per consumer (§3). Never shared, never locked. */
export const Checkpoint = z.object({
  consumer: z.string(),
  last_event_id: z.string().nullable(),
  updated_at: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const CONSUMERS = ['analyzer', 'projector'] as const;
export type Consumer = (typeof CONSUMERS)[number];
