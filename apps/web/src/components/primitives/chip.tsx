import { Link } from 'react-router';

/**
 * A taxonomy value. Neutral by default and accent-tinted only when selected: colour here
 * encodes interaction state, never category. Eight facetable families is already past the
 * point where categorical hues stay distinguishable — the palette validator rejected the
 * family-coloured version outright (violet↔blue ΔE 1.4 under deuteranopia). See the spec.
 */
type ChipProps = {
  label: string;
  count?: number;
  to?: string;
  title?: string;
  selected?: boolean;
};

const base =
  'inline-flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-xs transition-colors';

export function Chip({ label, count, to, title, selected = false }: ChipProps) {
  const tone = selected
    ? 'bg-accent-soft text-accent-text ring-1 ring-accent/30'
    : 'bg-surface-2 text-fg-2 hover:text-fg';

  const body = (
    <>
      {label}
      {count !== undefined && <span className="font-mono text-faint tabular-nums">{count}</span>}
    </>
  );

  if (!to) return <span className={`${base} ${tone}`}>{body}</span>;

  return (
    <Link to={to} title={title} className={`${base} ${tone}`}>
      {body}
    </Link>
  );
}
