import type { Cache } from '@keco/cache';
import { ICON_SIZES, repoKeys, type IconSize } from '@keco/cache/keys';
import sharp from 'sharp';
import { resolveIconCandidate, type IconInputs } from './icon-candidate';

/**
 * Derived artifacts, in the same relationship to `icon.src` that `analysis/**` has to
 * `repos/**` (spec §2.2): the fetched bytes are stored verbatim per §3, and these are
 * regenerated from them offline, so a bug here is fixed by re-deriving rather than by a
 * re-crawl.
 *
 * Rasterising also strips every active element out of an SVG, which is why the route serving
 * these needs no separate sanitiser.
 */
export async function deriveIconSizes(source: Buffer): Promise<Map<IconSize, Buffer>> {
  const derived = new Map<IconSize, Buffer>();
  for (const size of ICON_SIZES) {
    derived.set(
      size,
      await sharp(source)
        // `inside` fits without padding, so a wordmark stays a wordmark and the portal boxes
        // it with `object-contain`. Upscaling is allowed: a small committed logo is still the
        // project's real mark, and the alternative is an icon that silently ignores its size.
        .resize(size, size, { fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer(),
    );
  }
  return derived;
}

/** `repos/{owner}/{repo}/icon.json`. `source: null` means there is no usable icon today. */
export type IconMeta = {
  source: 'repo-logo' | 'owner-avatar' | null;
  source_url: string | null;
  content_type: string | null;
  bytes: number | null;
  etag: string | null;
  sizes: number[];
  fetched_at: string;
  /** Why the last attempt produced nothing. Kept so a known-dead URL is not retried blindly. */
  error: string | null;
};

export type IconDeps = {
  fetch: typeof globalThis.fetch;
  now?: () => Date;
};

/**
 * Bounds what one repo can pull down. Comfortably above any real logo — the largest in the
 * CNCF landscape is well under 200 KB — and small enough that 30k of them is not a surprise.
 */
const MAX_ICON_BYTES = 512 * 1024;

export async function updateIcon(
  cache: Cache,
  inputs: IconInputs,
  deps: IconDeps,
): Promise<IconMeta> {
  const keys = repoKeys(inputs.repo);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const previous = await cache.getJSON<IconMeta>(keys.iconMeta);

  /**
   * Degrade, never fail (§4.2). A previously good icon survives a later failure: its bytes are
   * still in the cache, so blanking the descriptor would hide an icon that works over a
   * transient 500.
   */
  const fail = async (error: string): Promise<IconMeta> => {
    const meta: IconMeta =
      previous && previous.source !== null
        ? { ...previous, fetched_at: now, error }
        : {
            source: null,
            source_url: null,
            content_type: null,
            bytes: null,
            etag: null,
            sizes: [],
            fetched_at: now,
            error,
          };
    await cache.putJSON(keys.iconMeta, meta);
    return meta;
  };

  const candidate = resolveIconCandidate(inputs);
  if (candidate === null) {
    return fail('no candidate: no logo in the tree or README, and no owner avatar');
  }

  // Conditional only when the previous success came from this same URL — a project that moved
  // its logo must not be answered with the old file's ETag.
  const conditional =
    previous?.etag != null && previous.source_url === candidate.url && previous.sizes.length > 0;

  let response: Response;
  try {
    response = await deps.fetch(candidate.url, {
      headers: conditional ? { 'if-none-match': previous.etag! } : {},
      redirect: 'follow',
    });
  } catch (error) {
    return fail(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 304 && previous) {
    const meta: IconMeta = { ...previous, fetched_at: now, error: null };
    await cache.putJSON(keys.iconMeta, meta);
    return meta;
  }
  if (!response.ok) return fail(`fetch failed: HTTP ${response.status}`);

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!contentType.startsWith('image/')) {
    return fail(`unexpected content type: ${contentType || 'none'}`);
  }

  const source = Buffer.from(await response.arrayBuffer());
  if (source.byteLength > MAX_ICON_BYTES) {
    // Abandoned, not truncated: half a PNG is not a smaller PNG.
    return fail(`icon too large: ${source.byteLength} bytes exceeds ${MAX_ICON_BYTES}`);
  }

  let derived: Map<IconSize, Buffer>;
  try {
    derived = await deriveIconSizes(source);
  } catch (error) {
    return fail(
      `could not decode image: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Verbatim first (§3), then the derivatives, then the metadata that makes them findable.
  // Every put is atomic, so a crash mid-sequence leaves earlier files complete and the meta
  // absent — which the next run treats as "no icon yet" and simply redoes. `putBuffer`, not
  // `putText`: a UTF-8 round trip would silently corrupt every one of these bytes.
  await cache.putBuffer(keys.iconSource, source, contentType);
  await Promise.all(
    [...derived].map(([size, png]) => cache.putBuffer(keys.icon(size), png, 'image/png')),
  );

  const meta: IconMeta = {
    source: candidate.source,
    source_url: candidate.url,
    content_type: contentType,
    bytes: source.byteLength,
    etag: response.headers.get('etag'),
    sizes: [...ICON_SIZES],
    fetched_at: now,
    error: null,
  };
  await cache.putJSON(keys.iconMeta, meta);
  return meta;
}
