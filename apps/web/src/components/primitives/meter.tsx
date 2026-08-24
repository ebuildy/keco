/**
 * A 0–1 magnitude. One hue, more-is-darker — four discrete steps rather than a continuous
 * interpolation, so the same score always paints the same colour.
 *
 * The bar is decoration: `role="img"` plus a label is what a screen reader gets, and every
 * caller renders the number beside it. Colour is reinforcement, never the only encoding.
 */
const STEPS = [
  { max: 0.4, className: 'bg-health-1' },
  { max: 0.65, className: 'bg-health-2' },
  { max: 0.85, className: 'bg-health-3' },
  { max: Infinity, className: 'bg-health-4' },
];

// The last step's max is Infinity, so `.find` only misses for a non-finite `value` (e.g. NaN);
// the literal fallback below is that same last step's className, not an indexed re-lookup —
// `noUncheckedIndexedAccess` would otherwise type `STEPS[STEPS.length - 1]` as possibly
// undefined even though the array is a fixed, non-empty constant.
export const healthClass = (value: number): string =>
  STEPS.find((step) => value < step.max)?.className ?? 'bg-health-4';

type MeterProps = {
  value: number;
  label: string;
  /** Share of the axis that could be scored at all — drawn as a dashed ceiling. */
  coverage?: number;
  className?: string;
};

export function Meter({ value, label, coverage, className = '' }: MeterProps) {
  const percent = Math.max(0, Math.min(1, value)) * 100;

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`${label}: ${value.toFixed(2)} out of 1.00`}
        className="relative h-1.5 w-full overflow-hidden rounded-[3px] bg-surface-2"
      >
        <span
          className={`block h-full rounded-r-[3px] ${healthClass(value)}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {coverage !== undefined && coverage < 1 && (
        <div
          className="mt-0.5 h-0.5 rounded-full"
          style={{
            width: `${Math.max(0, Math.min(1, coverage)) * 100}%`,
            backgroundImage:
              'repeating-linear-gradient(90deg, var(--keco-border-strong) 0 3px, transparent 3px 6px)',
          }}
        />
      )}
    </div>
  );
}
