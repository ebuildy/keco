import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { FsStorage } from './adapters/fs';
import { S3Storage } from './adapters/s3';
import { Cache, type Storage } from './storage';

export * from './keys';
export * from './storage';
export * from './journal';
export { FsStorage } from './adapters/fs';
export { S3Storage } from './adapters/s3';

export type CacheConfig = {
  adapter: 'fs' | 's3';
  dir?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  secret?: string;
};

/**
 * A relative CACHE_DIR is resolved against the workspace root, not the process's cwd —
 * otherwise `pnpm -F @keco/workers …` and `next dev` each get their own private cache and
 * the pipeline silently produces nothing the portal can see.
 */
export function resolveCacheDir(dir: string, from = process.cwd()): string {
  if (isAbsolute(dir)) return dir;
  for (let current = from; ; current = dirname(current)) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return resolve(current, dir);
    if (dirname(current) === current) return resolve(from, dir);
  }
}

export function createStorage(config: CacheConfig): Storage {
  if (config.adapter === 'fs') return new FsStorage(resolveCacheDir(config.dir ?? '.cache'));
  if (!config.bucket || !config.accessKey || !config.secret) {
    throw new Error('CACHE_BUCKET, CACHE_ACCESS_KEY and CACHE_SECRET are required for the s3 adapter');
  }
  return new S3Storage({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKey,
    secretAccessKey: config.secret,
  });
}

/** Reads cache config from the environment. Workers get read-write credentials, the web app read-only (§12). */
export function createCacheFromEnv(env: NodeJS.ProcessEnv = process.env): Cache {
  return new Cache(
    createStorage({
      adapter: (env.CACHE_ADAPTER as 'fs' | 's3') ?? 'fs',
      dir: env.CACHE_DIR,
      endpoint: env.CACHE_ENDPOINT,
      bucket: env.CACHE_BUCKET,
      region: env.CACHE_REGION,
      accessKey: env.CACHE_ACCESS_KEY,
      secret: env.CACHE_SECRET,
    }),
  );
}

export { Cache };

/**
 * The change signal for the entire pipeline (§3) — and the single most important cost
 * control in the system. Unchanged hash ⇒ no analysis, no LLM call, no re-projection.
 *
 * Deliberately covers only the fields that change what we say about a repo: star counts
 * churn constantly and must NOT be in here, or every crawl would re-analyze the corpus.
 */
export function contentHash(input: {
  repo: { description?: string | null; topics?: string[]; homepage?: string | null; archived?: boolean; license?: { spdx_id?: string | null } | null; default_branch?: string };
  readme: string | null;
  treePaths: string[];
}): string {
  const core = {
    description: input.repo.description ?? null,
    topics: [...(input.repo.topics ?? [])].sort(),
    homepage: input.repo.homepage ?? null,
    archived: Boolean(input.repo.archived),
    license: input.repo.license?.spdx_id ?? null,
    default_branch: input.repo.default_branch ?? null,
    readme: input.readme ?? '',
    tree: [...input.treePaths].sort(),
  };
  return createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 32);
}
