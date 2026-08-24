import type { ToolDocument } from '@keco/core';
import { formatUtcDate } from '../../lib/dates';

/**
 * Repository facts, straight from the document.
 *
 * Dates go through `formatUtcDate`, which exists because a bare `toDateString()`
 * hydration-mismatches near midnight between the prerender build machine and the reader's
 * browser (§9).
 */
export function FactList({ tool }: { tool: ToolDocument }) {
  const facts: [string, React.ReactNode][] = [
    ['Stars', <span className="font-mono tabular-nums">{tool.stars.toLocaleString('en-GB')}</span>],
    ['Forks', <span className="font-mono tabular-nums">{tool.forks.toLocaleString('en-GB')}</span>],
    ['Language', tool.language ?? 'unknown'],
    ['Licence', tool.license ?? 'none declared'],
    ['Last commit', formatUtcDate(tool.pushed_at)],
  ];

  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-card">
      <dl className="space-y-2 text-[12.5px]">
        {facts.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">{label}</dt>
            <dd className="text-fg-2">{value}</dd>
          </div>
        ))}

        {/* Only claimed when OSV actually answered. A repo it never scanned has no vulnerability
            record, which is not the same as having none — §4.3's "missing ≠ bad". */}
        {tool.signals.osv !== null && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">Open CVEs</dt>
            <dd className={tool.signals.osv.open_vulns > 0 ? 'text-bad' : 'text-good'}>
              {tool.signals.osv.open_vulns > 0 ? tool.signals.osv.open_vulns : '✓ none'}
            </dd>
          </div>
        )}
      </dl>

      <a
        href={tool.repo_url}
        rel="noreferrer"
        className="mt-3 block border-t border-line pt-2.5 text-[12.5px] text-accent-text"
      >
        ↗ Source on GitHub
      </a>
    </section>
  );
}
