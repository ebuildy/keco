import { useEffect, useState } from 'react';
import type { IconSize, ToolDocument } from '@keco/core';
import { iconUrl, monogram } from '../../lib/icon';

/**
 * A project's icon, or a monogram tile standing in for one.
 *
 * The document says whether an icon exists, so the common case — a repo the crawler has not
 * reached — costs no request at all. `onError` still falls back, because the document and the
 * cache are two systems and eventual consistency is the contract (§2.7): a document projected
 * before its icon landed must render a placeholder, never a broken-image glyph.
 *
 * Decorative by design: `alt=""` and `aria-hidden`, because the repository's name sits
 * immediately beside it on both surfaces and a screen reader announcing it twice is noise.
 */
type Props = {
  tool: Pick<ToolDocument, 'full_name' | 'icon'>;
  /** The source to request. The rendered box is set by `className`. */
  size: IconSize;
  className?: string;
};

export function ToolIcon({ tool, size, className = '' }: Props) {
  const [failed, setFailed] = useState(false);

  // A client navigation swaps the tool without remounting; without this, one broken icon
  // would blank the next repo's.
  useEffect(() => setFailed(false), [tool.full_name]);

  const box = `shrink-0 overflow-hidden rounded-[6px] ${className}`;

  if (tool.icon === null || failed) {
    const { letter, hue } = monogram(tool.full_name);
    return (
      <span
        aria-hidden="true"
        // Decorative, so neither branch has a role or a name to match on. This is the seam the
        // e2e tests locate them by — see e2e/search.e2e.ts.
        data-icon="monogram"
        className={`${box} grid place-items-center border border-line font-semibold text-white`}
        // Inline because the hue is per-repo data, not a design token: there is no finite set
        // of utilities to generate. Fixed lightness and saturation keep every tile legible in
        // both themes, which is why this pair is not read from theme.css.
        style={{ backgroundColor: `hsl(${hue} 45% 42%)`, fontSize: '0.5em' }}
      >
        {letter}
      </span>
    );
  }

  return (
    <img
      src={iconUrl(tool.full_name, size)}
      srcSet={
        size === 32
          ? `${iconUrl(tool.full_name, 32)} 1x, ${iconUrl(tool.full_name, 64)} 2x`
          : undefined
      }
      alt=""
      aria-hidden="true"
      data-icon="image"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`${box} bg-surface object-contain`}
    />
  );
}
