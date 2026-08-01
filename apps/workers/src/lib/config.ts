import 'dotenv/config';
import { z } from 'zod';

/** Every external input is validated at the boundary (AGENTS.md §13) — including the environment. */
const Env = z.object({
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_QUOTA_CRAWLER_SHARE: z.coerce.number().min(0).max(1).default(0.8),

  CACHE_ADAPTER: z.enum(['fs', 's3']).default('fs'),
  CACHE_DIR: z.string().default('.cache'),
  CACHE_ENDPOINT: z.string().optional(),
  CACHE_BUCKET: z.string().optional(),
  CACHE_REGION: z.string().optional(),
  CACHE_ACCESS_KEY: z.string().optional(),
  CACHE_SECRET: z.string().optional(),

  MEILI_HOST: z.string().default('http://localhost:7700'),
  MEILI_MASTER_KEY: z.string().optional(),

  /** Deterministic sharding, never locks or leases (§4). */
  SHARD_COUNT: z.coerce.number().int().min(1).default(1),
  SHARD_INDEX: z.coerce.number().int().min(0).default(0),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANALYZER_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export const config = Env.parse(process.env);
export type Config = z.infer<typeof Env>;
