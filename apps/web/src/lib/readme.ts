import { createCacheFromEnv, repoKeys } from '@keco/cache';
import 'server-only';

/**
 * The one place the read side touches write-side storage (§9): a read, by key, of an
 * immutable blob. Never write, never list. The web app's cache credential is read-only.
 */
const cache = createCacheFromEnv();

export async function readReadme(fullName: string): Promise<string | null> {
  return cache.getText(repoKeys(fullName).readme);
}

export type ReadmeMeta = {
  path: string;
  branch: string;
  etag: string | null;
  /** Relative README image paths break unless rewritten against this (§14). */
  image_base_url: string;
};

export async function readReadmeMeta(fullName: string): Promise<ReadmeMeta | null> {
  return cache.getJSON<ReadmeMeta>(repoKeys(fullName).readmeMeta);
}
