import { Link } from 'react-router';
import type { ChipRow } from '../lib/topics';
import { Chip } from './primitives/chip';

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
    <section aria-labelledby="browse" className="py-8">
      <h2 id="browse" className="mb-4 text-[15px] font-bold tracking-tight text-fg">
        Browse
      </h2>
      <div className="space-y-4">
        {rows.map((row) => (
          <nav key={row.familyId} aria-label={row.label}>
            <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
              {row.label}
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {row.chips.map((chip) => (
                <li key={chip.id}>
                  <Chip
                    label={chip.label}
                    count={chip.count}
                    to={chip.href}
                    title={chip.description}
                  />
                </li>
              ))}
              {row.moreHref && (
                <li>
                  <Link to={row.moreHref} className="px-2 py-0.5 text-xs text-accent-text">
                    more →
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        ))}
      </div>
    </section>
  );
}
