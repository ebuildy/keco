import pino from 'pino';
import { config } from './config';

/**
 * Structured logging (§13): one debug line per repo, one info summary per batch, and the
 * checkpoint position in every summary — that last one is how you tell whether the
 * pipeline is keeping up.
 */
export const logger = pino({ level: config.LOG_LEVEL, base: undefined });

export const workerLogger = (worker: string) =>
  logger.child({ worker, shard: `${config.SHARD_INDEX}/${config.SHARD_COUNT}` });
