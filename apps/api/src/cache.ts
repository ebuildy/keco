import { createCacheFromEnv, type Cache } from '@keco/cache';
import type { Env } from './env';

/**
 * The one place the read side touches write-side storage (AGENTS.md §9): reads, by key, of
 * immutable blobs. Never write, never list — a directory scan here is the §14 mistake that
 * becomes billed-per-request the day object storage lands.
 */
export const readCache = (env: Env): Cache => createCacheFromEnv({ CACHE_DIR: env.CACHE_DIR });
