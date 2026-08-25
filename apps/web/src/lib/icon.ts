import type { IconSize } from '@keco/core';

/**
 * Icons on the read side.
 *
 * The bytes live in the cache, which a browser cannot read, so they arrive through
 * `apps/api` — the same arrangement as the README (AGENTS.md §9). Whether an icon exists at
 * all is known from the document's `icon` descriptor, so a repo without one never fires a
 * request that 404s.
 *
 * `IconSize` comes from `@keco/core`, which is also where `apps/api` reads it: the route
 * rejects any size outside that list, so a second hardcoded copy here would be a 400 waiting
 * to happen.
 */
export type { IconSize };

export const iconUrl = (fullName: string, size: IconSize): string =>
  `/api/icon/${fullName}/${size}.png`;

/**
 * The placeholder for a repo with no icon: its initial on a tile whose hue is derived from
 * its name.
 *
 * The hue is decorative and carries no meaning — it is not a category and it is not a state,
 * so it stays clear of §9's rule that colour encodes state. What it does carry is stability:
 * the same repo gets the same tile on every surface and every visit, which is what makes it
 * read as a stand-in for a logo rather than as a signal.
 */
export function monogram(fullName: string): { letter: string; hue: number } {
  const name = fullName.slice(fullName.indexOf('/') + 1);
  const letter = [...name].find((character) => /[a-z0-9]/i.test(character))?.toUpperCase() ?? '?';

  // FNV-1a: a few lines, no dependency, and well spread for short strings.
  let hash = 0x811c9dc5;
  for (let index = 0; index < fullName.length; index += 1) {
    hash ^= fullName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return { letter, hue: Math.abs(hash) % 360 };
}
