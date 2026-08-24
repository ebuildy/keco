import { ICON_SIZES, type IconSize } from '@keco/cache/keys';
import sharp from 'sharp';

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
