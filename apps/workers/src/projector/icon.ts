import { IconDescriptor } from '@keco/core';

/**
 * `icon.json` → the `icon` field of a `ToolDocument`, or `null`.
 *
 * Validated rather than cast. The taxonomy lesson in the projector's own TODO applies here:
 * Meilisearch accepts any value, `searchTools` does not parse the response, and the portal
 * renders what it is given — so a malformed descriptor becomes a broken image for every
 * reader, and nothing downstream would notice. The write side is what guarantees read-model
 * correctness (§2).
 *
 * `error` is deliberately not a disqualifier: a transient failure recorded on top of an icon
 * whose bytes are still cached must not blank it.
 */
export function iconDescriptor(meta: unknown): IconDescriptor | null {
  if (meta === null || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  // No derivatives means nothing for `apps/api` to serve, whatever the rest of the file says.
  if (!Array.isArray(record.sizes) || record.sizes.length === 0) return null;

  const parsed = IconDescriptor.safeParse({
    source: record.source,
    source_url: record.source_url,
    fetched_at: record.fetched_at,
  });
  return parsed.success ? parsed.data : null;
}
