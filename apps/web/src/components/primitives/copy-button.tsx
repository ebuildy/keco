import { useState } from 'react';

/**
 * Copies a verified install command. The command comes from the document's `install_methods`
 * and is never constructed here — §6 names a fabricated `brew install` line as the worst bug
 * this project can ship, because people paste these straight into a terminal.
 */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="shrink-0 rounded-control border border-line-strong px-2 py-0.5 text-xs text-muted transition-colors hover:text-fg"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          // A denied clipboard permission is not worth an error state; the command is on screen.
          () => undefined,
        );
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
