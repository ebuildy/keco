import { forwardRef } from 'react';
import { Link } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { formatUtcDate } from '../../lib/dates';
import { Chip } from '../primitives/chip';
import { Meter } from '../primitives/meter';
import { StatusPill } from '../primitives/status-pill';

/**
 * One result.
 *
 * `forwardRef` because the search page drives focus through a roving tabindex and needs the
 * anchor itself. Results are links, so a genuinely focused one gets Enter, middle-click and
 * "open in new tab" from the browser rather than from handlers we would have to reimplement
 * and would get subtly wrong.
 *
 * Health renders as a same-hue meter with the number beside it; the pills beside the name are
 * the only place colour carries meaning on its own terms, and each pairs a tone with a word.
 */
type Props = {
  tool: ToolDocument;
  view: 'list' | 'grid';
  tabIndex: number;
};

export const ResultCard = forwardRef<HTMLAnchorElement, Props>(function ResultCard(
  { tool, view, tabIndex },
  ref,
) {
  const meta = [
    `★ ${tool.stars.toLocaleString('en-GB')}`,
    tool.language,
    tool.license,
    `pushed ${formatUtcDate(tool.pushed_at)}`,
  ].filter(Boolean);

  return (
    <Link
      ref={ref}
      to={`/tools/${tool.full_name}`}
      tabIndex={tabIndex}
      className="block rounded-card border border-line bg-surface p-3.5 shadow-card transition-colors hover:border-accent focus-visible:border-accent"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[14.5px] font-semibold text-accent-text">{tool.name}</span>
        <span className="text-[11.5px] text-faint">{tool.owner}</span>
        {tool.archived && <StatusPill tone="warn">Archived</StatusPill>}
        {tool.needs_review && <StatusPill tone="warn">Needs review</StatusPill>}
        {/* `signals` is required on ToolDocument; `osv` is nullable. Narrow the second only. */}
        {tool.signals.osv !== null && tool.signals.osv.open_vulns > 0 && (
          <StatusPill tone="bad">{tool.signals.osv.open_vulns} open CVEs</StatusPill>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Meter value={tool.score.total} label={`${tool.full_name} health`} className="w-16" />
          <span className="font-mono text-xs font-semibold tabular-nums text-accent-text">
            {tool.score.total.toFixed(2)}
          </span>
        </div>
      </div>

      <p
        className={`mt-1.5 text-[12.5px] leading-relaxed text-fg-2 ${
          view === 'grid' ? 'line-clamp-3' : ''
        }`}
      >
        {tool.summary}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Chip label={`kind: ${tool.kind}`} />
        {tool.domains.slice(0, 2).map((domain) => (
          <Chip key={domain} label={domain} />
        ))}
        <span className="ml-auto font-mono text-[11px] text-muted">{meta.join(' · ')}</span>
      </div>
    </Link>
  );
});
