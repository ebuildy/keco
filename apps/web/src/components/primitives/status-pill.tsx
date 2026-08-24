/**
 * Genuine state — archived, open vulnerabilities, needs review. Never a score.
 *
 * Every pill carries an icon *and* a word, so the status is never colour alone. Green/amber/red
 * is reserved for this component precisely so that a health score cannot borrow it: §4.4's
 * "missing ≠ bad" is incompatible with painting a repo red because OpenSSF never scanned it.
 */
type Tone = 'good' | 'warn' | 'bad';

const TONES: Record<Tone, { className: string; icon: string }> = {
  good: { className: 'bg-good-soft text-good', icon: '✓' },
  warn: { className: 'bg-warn-soft text-warn', icon: '⚠' },
  bad: { className: 'bg-bad-soft text-bad', icon: '✕' },
};

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const { className, icon } = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-xs font-semibold ${className}`}
    >
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}
