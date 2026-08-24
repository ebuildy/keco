import type { ToolDocument } from '@keco/core';
import { Meter } from '../primitives/meter';

/**
 * The four score axes and their weights (§4.4), plus the aggregate and its coverage.
 *
 * Health is magnitude, so this is one hue, more-is-darker, with the number always beside the
 * bar. It is deliberately never green/amber/red: §4.3 and §4.4 make "missing ≠ bad" a rule,
 * and painting a repo red because OpenSSF's cron set never scanned it is exactly the
 * corpus-wide bias they forbid. Status colour belongs to `StatusPill`, which reports states —
 * archived, open CVEs — not scores.
 *
 * `quality_coverage` is drawn as a dashed ceiling on the Quality axis *and* stated in words,
 * because a 0.9 from four signals and a 0.9 from one are not the same claim.
 */
const AXES = [
  { key: 'popularity', label: 'Popularity', weight: 35 },
  { key: 'activity', label: 'Activity', weight: 30 },
  { key: 'adoption', label: 'Adoption', weight: 20 },
  { key: 'quality', label: 'Quality', weight: 15 },
] as const;

export function ScoreMeters({ score }: { score: ToolDocument['score'] }) {
  const coveragePercent = Math.round(score.quality_coverage * 100);

  return (
    <section
      aria-labelledby="health"
      className="rounded-card border border-line bg-surface p-4 shadow-card"
    >
      <h2
        id="health"
        className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-faint"
      >
        Health
      </h2>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[32px] font-semibold tracking-tight text-fg tabular-nums">
          {score.total.toFixed(2)}
        </span>
        <span className="text-[11.5px] text-muted">of 1.00</span>
      </div>

      <p className="mb-4 mt-1 text-[11px] leading-relaxed text-faint">
        Quality scored on <strong className="font-semibold text-fg-2">{coveragePercent}%</strong>{' '}
        of its signals. Anything a provider never reported is treated as unknown, not as zero.
      </p>

      <dl className="space-y-2.5">
        {AXES.map((axis) => (
          <div key={axis.key}>
            <div className="mb-1 flex items-baseline justify-between text-[11.5px]">
              <dt className="text-fg-2">
                {axis.label} <span className="text-faint">·{axis.weight}%</span>
              </dt>
              <dd className="font-mono tabular-nums text-fg">{score[axis.key].toFixed(2)}</dd>
            </div>
            <Meter
              value={score[axis.key]}
              label={axis.label}
              coverage={axis.key === 'quality' ? score.quality_coverage : undefined}
            />
          </div>
        ))}
      </dl>
    </section>
  );
}
