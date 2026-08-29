import type { Consumer } from '@keco/core';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';

/**
 * `kecoctl checkpoint reset --consumer analyzer` — rewind a consumer (AGENTS.md §3).
 *
 * Replay is normal operation, not an incident: reset the checkpoint and everything downstream
 * rebuilds from the cache, with zero GitHub calls.
 *
 * The directory keeps the name `replay` because replay is the concept §3 names; `checkpoint` is
 * the noun the command operates on.
 */
const log = workerLogger('replay');

export type CheckpointResetOptions = {
  /** Validated against CONSUMERS by commander's `.choices()` before this runs. */
  consumer: Consumer;
};

export async function runCheckpointReset({ consumer }: CheckpointResetOptions): Promise<void> {
  const { journal } = createRuntime();
  const before = await journal.checkpoint(consumer);
  await journal.reset(consumer);

  log.info(
    { consumer, from: before.last_event_id, to: null },
    'checkpoint reset — next run replays from the beginning',
  );
}
