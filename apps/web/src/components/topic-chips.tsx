import { Link } from 'react-router';
import type { ChipRow } from '../lib/topics';

/**
 * Browse-by-topic rows (AGENTS.md §9). Plain links, which is what makes the rows crawlable
 * and what keeps them working before the JS bundle has loaded.
 *
 * A value with no documents behind it renders no chip, so this renders nothing at all until
 * the first crawl fills the index — no dead links, no wall of zero-count chips.
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
                <Link to={chip.href} title={chip.description}>
                  {chip.label} <span aria-label={`${chip.count} tools`}>{chip.count}</span>
                </Link>
              </li>
            ))}
            {row.moreHref && (
              <li>
                <Link to={row.moreHref}>more →</Link>
              </li>
            )}
          </ul>
        </nav>
      ))}
    </section>
  );
}
