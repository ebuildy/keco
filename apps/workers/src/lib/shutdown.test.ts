import { describe, expect, it, vi } from 'vitest';
import { createShutdown, SHUTDOWN_GRACE_MS } from './shutdown';

const silentLog = () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

/** A flush we can hold open, to model one still running when the next signal lands. */
function deferredFlush() {
  let release!: () => void;
  const started = vi.fn();
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    started,
    flush: (): Promise<void> => {
      started();
      return promise;
    },
  };
}

describe('createShutdown', () => {
  it('flushes, tidies and exits on the first signal', async () => {
    const exit = vi.fn();
    const done = vi.fn();
    const flush = vi.fn(async () => {});
    const handle = createShutdown({ flush, done, exit, log: silentLog() });

    handle('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(flush).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('exits 143 on SIGTERM', async () => {
    const exit = vi.fn();
    const handle = createShutdown({
      flush: async () => {},
      done: () => {},
      exit,
      log: silentLog(),
    });

    handle('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
  });

  it('does not abort the flush when the process group echoes the signal 20ms later', async () => {
    // The regression this whole module exists for. A terminal Ctrl-C signals the group
    // (mise -> pnpm -> tsx -> node), and the wrappers' teardown delivers node a SIGTERM ~20ms
    // behind the SIGINT. Treating that as "abort now" discarded the entire sweep: no state
    // file, no full list, only orphaned detail documents.
    const exit = vi.fn();
    const done = vi.fn();
    const held = deferredFlush();
    let clock = 1_000;
    const handle = createShutdown({
      flush: held.flush,
      done,
      exit,
      log: silentLog(),
      now: () => clock,
    });

    handle('SIGINT');
    await vi.waitFor(() => expect(held.started).toHaveBeenCalled());

    clock += 20;
    handle('SIGTERM');

    // The flush is still in flight, so nothing may have exited yet.
    expect(exit).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();

    held.release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(done).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('ignores repeated signals for the whole grace window', async () => {
    const exit = vi.fn();
    const held = deferredFlush();
    let clock = 0;
    const handle = createShutdown({
      flush: held.flush,
      done: () => {},
      exit,
      log: silentLog(),
      now: () => clock,
    });

    handle('SIGINT');
    for (const offset of [1, 20, SHUTDOWN_GRACE_MS - 1]) {
      clock = offset;
      handle('SIGTERM');
    }

    expect(exit).not.toHaveBeenCalled();
  });

  it('aborts without flushing when the operator signals again after the grace window', () => {
    const exit = vi.fn();
    const done = vi.fn();
    const held = deferredFlush();
    let clock = 0;
    const handle = createShutdown({
      flush: held.flush,
      done,
      exit,
      log: silentLog(),
      now: () => clock,
    });

    handle('SIGINT');
    clock = SHUTDOWN_GRACE_MS + 1;
    handle('SIGINT');

    // Exits immediately, with the flush still unresolved — that is the point of the escape
    // hatch, and why the window is a second rather than a minute.
    expect(exit).toHaveBeenCalledWith(130);
    expect(done).not.toHaveBeenCalled();
  });

  it('still exits when the flush itself throws', async () => {
    const exit = vi.fn();
    const done = vi.fn();
    const log = silentLog();
    const handle = createShutdown({
      flush: async () => {
        throw new Error('disk full');
      },
      done,
      exit,
      log,
    });

    handle('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));

    expect(done).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'disk full' }),
      'flush on shutdown failed',
    );
  });
});
