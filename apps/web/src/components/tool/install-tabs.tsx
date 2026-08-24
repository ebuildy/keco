import { useState } from 'react';
import type { ToolDocument } from '@keco/core';
import { formatUtcDate } from '../../lib/dates';
import { CopyButton } from '../primitives/copy-button';

/**
 * One tab per *verified* install method.
 *
 * Nothing here constructs a command. Every string comes from the document, where it was
 * written only after being proven against a registry, and each carries the `source_url` that
 * proves it (§6). An empty list renders the honest sentence rather than a plausible guess:
 * rendering a `brew install` line for a formula that does not exist is the single worst bug
 * this project can ship, because people paste these straight into a terminal.
 */
export function InstallTabs({ methods }: { methods: ToolDocument['install_methods'] }) {
  const [active, setActive] = useState(0);

  if (methods.length === 0) {
    return (
      <section aria-labelledby="install" className="rounded-card border border-line bg-surface p-4">
        <h2 id="install" className="mb-1.5 text-[15px] font-semibold text-fg">
          Install
        </h2>
        <p className="text-[13px] text-muted">
          No install method has been verified against a registry, so none is listed.
        </p>
      </section>
    );
  }

  // Clamped rather than indexed directly: `methods` can shrink under a client navigation to a
  // different tool while `active` still points past the end of the new list.
  const index = Math.min(active, methods.length - 1);
  const method = methods[index];
  if (!method) return null;

  return (
    <section
      aria-labelledby="install"
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <h2 id="install" className="sr-only">
        Install
      </h2>

      <div
        role="tablist"
        aria-label="Install methods"
        className="flex items-center gap-0.5 border-b border-line px-1"
      >
        {methods.map((entry, position) => (
          <button
            key={entry.method}
            type="button"
            role="tab"
            id={`install-tab-${entry.method}`}
            aria-selected={position === index}
            aria-controls="install-panel"
            tabIndex={position === index ? 0 : -1}
            onClick={() => setActive(position)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const step = event.key === 'ArrowRight' ? 1 : -1;
              setActive((current) => (current + step + methods.length) % methods.length);
            }}
            className={`px-3 py-2 font-mono text-xs transition-colors ${
              position === index
                ? 'border-b-2 border-accent font-medium text-accent-text'
                : 'text-muted hover:text-fg'
            }`}
          >
            {entry.method}
          </button>
        ))}
        <span className="ml-auto pr-2.5 text-[10.5px] text-faint">
          {methods.length} verified against a registry
        </span>
      </div>

      <div
        role="tabpanel"
        id="install-panel"
        aria-labelledby={`install-tab-${method.method}`}
        className="p-3.5"
      >
        <div className="flex items-center gap-2.5 rounded-control border border-line bg-surface-2 px-3 py-2.5">
          <span aria-hidden="true" className="shrink-0 font-mono text-good">
            $
          </span>
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-fg">
            {method.command}
          </code>
          <CopyButton value={method.command} />
        </div>

        <p className="mt-2 text-[11px] text-faint">
          <span aria-hidden="true" className="text-good">
            ✓
          </span>{' '}
          <a href={method.source_url} rel="noreferrer" className="text-accent-text underline">
            Proof this entry exists
          </a>
          {method.verified_at && <> · checked {formatUtcDate(method.verified_at)}</>}
        </p>
      </div>
    </section>
  );
}
