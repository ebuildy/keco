import { Link } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { ToolIcon } from '../primitives/tool-icon';

/** `findAlternatives()` output: same kind, overlapping domains, different owner (§9). */
export function RelatedList({ tools }: { tools: ToolDocument[] }) {
  if (tools.length === 0) return null;

  return (
    <section
      aria-labelledby="related"
      className="rounded-card border border-line bg-surface p-4 shadow-card"
    >
      <h2
        id="related"
        className="mb-2.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint"
      >
        Related
      </h2>
      <ul className="space-y-2.5">
        {tools.map((tool) => (
          <li key={tool.id}>
            <Link to={`/tools/${tool.full_name}`} className="flex items-start gap-2">
              <ToolIcon tool={tool} size={32} className="mt-0.5 size-5 text-xl" />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-accent-text">{tool.name}</span>
                <span className="block text-[11px] text-faint">
                  {tool.owner} ·{' '}
                  <span className="font-mono tabular-nums">{tool.score.total.toFixed(2)}</span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
