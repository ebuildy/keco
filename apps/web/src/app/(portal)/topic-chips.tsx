import Link from 'next/link';
import type { ChipRow } from '@/lib/topics';

/**
 * Browse-by-topic rows (§9). Plain links, so the page works with JavaScript disabled —
 * §15.5 requires it and it is also what makes the rows crawlable.
 */
export function TopicChips({ rows }: { rows: ChipRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="browse">
      <h2 id="browse">Browse</h2>
      {rows.map((row) => (
        <nav key={row.familyId} aria-label={row.label}>
          <h3>{row.label}</h3>
          <ul>
            {row.chips.map((chip) => (
              <li key={chip.id}>
                <Link href={chip.href} title={chip.description}>
                  {chip.label} <span aria-label={`${chip.count} tools`}>{chip.count}</span>
                </Link>
              </li>
            ))}
            {row.moreHref && (
              <li>
                <Link href={row.moreHref}>more →</Link>
              </li>
            )}
          </ul>
        </nav>
      ))}
    </section>
  );
}
