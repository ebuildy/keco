import { parseArgs } from 'node:util';
import { CONSUMERS, type Consumer } from '@keco/core';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';

/**
 * replay — reset a consumer's checkpoint (AGENTS.md §3).
 *
 * Replay is normal operation, not an incident: reset the checkpoint and everything
 * downstream rebuilds from the cache, with zero GitHub calls.
 *
 *   mise run replay -- --consumer analyzer
 */
const log = workerLogger('replay');

const { values } = parseArgs({
  options: { consumer: { type: 'string' } },
  allowPositionals: true,
});

const consumer = values.consumer as Consumer | undefined;
if (!consumer || !CONSUMERS.includes(consumer)) {
  log.error({ consumers: CONSUMERS }, '--consumer is required and must be one of the known consumers');
  process.exit(1);
}

const { journal } = createRuntime();
const before = await journal.checkpoint(consumer);
await journal.reset(consumer);

log.info({ consumer, from: before.last_event_id, to: null }, 'checkpoint reset — next run replays from the beginning');
