/**
 * Graceful shutdown for long-running workers.
 *
 * A worker that runs for hours will be interrupted — that is normal operation, not an
 * incident (AGENTS.md §4, "every worker is safe to kill at any moment"). `try/finally` cannot
 * help: a signal tears the process down without unwinding, so the durable-write-before-exit
 * has to happen in the handler.
 */

export type Signal = 'SIGINT' | 'SIGTERM';

/** 128 + signal number, the shell convention. */
const EXIT_CODES: Record<Signal, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * How long after the first signal a follow-up is treated as an echo of the same interruption
 * rather than an operator insisting.
 *
 * This exists because a terminal Ctrl-C does not signal one process. It signals the whole
 * process group — here `mise → pnpm → tsx → node` — and the wrappers then tear down, which
 * delivers node a SIGTERM roughly 20ms behind the SIGINT. Treating that second signal as
 * "abort now" killed the in-flight flush and discarded the entire sweep: no `_state.json`, no
 * `repos-full-list.yaml`, only orphaned detail files. Keying on "have we started shutting
 * down" is not enough; the handler has to distinguish a process manager echoing the first
 * signal from a human pressing Ctrl-C again, and the only thing that separates them is time.
 *
 * (The artifacts named above were the pre-`DataStore` filesystem ones; discovery now loses an
 * unflushed corpus batch and its run record instead. The failure mode is identical.)
 *
 * This window is necessary but **not sufficient on its own**, and the other half lives in
 * `apps/workers/package.json`: the worker is started as `node --import tsx`, not under the
 * `tsx` CLI. The tsx CLI is a supervisor that spawns the real process as a child and tears it
 * down about 110ms after it receives a group signal — measured, and far short of the ~500ms a
 * 50k-repo flush takes (~950ms at 100k, see `DiscoveryStore.windowCompleted`). Under the CLI
 * no handler can win, however patient it is; as a loader there is only one process and the
 * signal reaches this code directly. If a worker with durable state is ever switched back to
 * plain `tsx`, Ctrl-C silently starts discarding work again.
 */
export const SHUTDOWN_GRACE_MS = 1_000;

export type ShutdownLogger = {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
  debug(fields: object, message: string): void;
};

export type ShutdownOptions = {
  /** Make the work durable. Must not throw — but is guarded anyway. */
  flush: () => Promise<void>;
  /** Tidy the terminal (e.g. close the progress bar) after the flush, before exiting. */
  done: () => void;
  log: ShutdownLogger;
  exit?: (code: number) => void;
  now?: () => number;
  graceMs?: number;
};

/**
 * Returns the signal handler. First signal: flush, tidy, exit. Any signal inside the grace
 * window: ignored, because it is the process group unwinding. A signal after it: the operator
 * really does want out, so exit immediately even at the cost of the flush.
 */
export function createShutdown(options: ShutdownOptions): (signal: Signal) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  let firstSignalAt: number | null = null;

  return (signal) => {
    const at = now();

    if (firstSignalAt !== null) {
      const sinceFirstMs = at - firstSignalAt;
      if (sinceFirstMs < graceMs) {
        options.log.debug(
          { signal, since_first_ms: sinceFirstMs },
          'shutdown already in progress — ignoring follow-up signal from the process group',
        );
        return;
      }
      options.log.warn({ signal, since_first_ms: sinceFirstMs }, 'aborting without flushing');
      exit(EXIT_CODES[signal]);
      return;
    }

    firstSignalAt = at;
    options.log.warn(
      { signal },
      'interrupted — flushing artifacts, signal again after 1s to abort without flushing',
    );

    void (async () => {
      try {
        await options.flush();
      } catch (error) {
        options.log.error(
          { signal, error: error instanceof Error ? error.message : String(error) },
          'flush on shutdown failed',
        );
      }
      options.done();
      exit(EXIT_CODES[signal]);
    })();
  };
}

/** Wires `createShutdown` to the real process signals. */
export function installShutdown(options: ShutdownOptions): void {
  const handle = createShutdown(options);
  process.on('SIGINT', () => handle('SIGINT'));
  process.on('SIGTERM', () => handle('SIGTERM'));
}
