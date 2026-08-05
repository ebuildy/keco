/**
 * Progress reporting for long sweeps (design 2026-08-02).
 *
 * Writes to stderr, never stdout: pino owns stdout, and `mise run discovery > out.log` has to
 * stay parseable JSON. Without a TTY it degrades to periodic log lines rather than filling a
 * CI log with carriage returns.
 */

export type ProgressSnapshot = {
  repos: number;
  windowsDone: number;
  windowsKnown: number;
  requests: number;
};

export interface Progress {
  update(snapshot: ProgressSnapshot): void;
  done(): void;
}

type Sink = { isTTY?: boolean; write(chunk: string): void };
type Log = { info(fields: object, message: string): void };

export type ProgressOptions = {
  stream?: Sink;
  log?: Log;
  now?: () => number;
  /** Minimum gap between TTY redraws. */
  redrawMs?: number;
  /** Minimum gap between non-TTY log lines. */
  intervalMs?: number;
};

const BAR_WIDTH = 24;

export function createProgress(options: ProgressOptions = {}): Progress {
  const stream: Sink = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  const redrawMs = options.redrawMs ?? 100;
  const intervalMs = options.intervalMs ?? 15_000;
  const startedAt = now();
  const tty = stream.isTTY === true;

  let lastEmitAt = -Infinity;
  let drawn = false;
  // The most recent snapshot passed to update(), and the most recent one actually rendered.
  // done() compares them so a sweep that finishes between throttled redraws still shows its
  // real final numbers instead of whatever was on screen when the throttle last let a draw
  // through.
  let lastSnapshot: ProgressSnapshot | undefined;
  let lastRenderedSnapshot: ProgressSnapshot | undefined;

  const eta = (snapshot: ProgressSnapshot): string => {
    if (snapshot.windowsDone === 0) return '—';
    const elapsed = now() - startedAt;
    // windowsKnown grows as windows subdivide (§ windows algebra), so remaining can be
    // transiently smaller than done's share implies — clamp instead of going negative.
    const remaining = Math.max(0, snapshot.windowsKnown - snapshot.windowsDone);
    return formatDuration((elapsed / snapshot.windowsDone) * remaining);
  };

  const render = (snapshot: ProgressSnapshot): void => {
    if (!tty) {
      options.log?.info(
        {
          repos: snapshot.repos,
          windows_done: snapshot.windowsDone,
          windows_known: snapshot.windowsKnown,
          requests: snapshot.requests,
          eta: eta(snapshot),
        },
        'discovering',
      );
      lastRenderedSnapshot = snapshot;
      return;
    }

    const ratio =
      snapshot.windowsKnown === 0 ? 0 : Math.min(1, snapshot.windowsDone / snapshot.windowsKnown);
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = '#'.repeat(filled) + '·'.repeat(BAR_WIDTH - filled);
    stream.write(
      `\rdiscovering  [${bar}]  ${count(snapshot.repos)} repos · window ` +
        `${snapshot.windowsDone}/${snapshot.windowsKnown} · ${count(snapshot.requests)} req · ` +
        `eta ${eta(snapshot)}   `,
    );
    drawn = true;
    lastRenderedSnapshot = snapshot;
  };

  return {
    update(snapshot) {
      lastSnapshot = snapshot;
      const at = now();
      if (at - lastEmitAt < (tty ? redrawMs : intervalMs)) return;
      lastEmitAt = at;
      render(snapshot);
    },

    done() {
      // Flush the true final numbers if the last update() call was throttled away — otherwise
      // the operator's last visible line is whatever was on screen several redraws ago.
      if (lastSnapshot !== undefined && lastSnapshot !== lastRenderedSnapshot) {
        render(lastSnapshot);
      }
      if (tty && drawn) stream.write('\n');
    },
  };
}

const count = (value: number): string => value.toLocaleString('en-US');

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
