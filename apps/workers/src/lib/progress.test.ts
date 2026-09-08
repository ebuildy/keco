import { describe, expect, it, vi } from 'vitest';
import { createProgress, formatDuration } from './progress';

const sink = (isTTY: boolean) => {
  const written: string[] = [];
  return { written, stream: { isTTY, write: (chunk: string) => void written.push(chunk) } };
};

describe('formatDuration', () => {
  it('renders coarse, human units', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m');
    expect(formatDuration(3_600_000)).toBe('1h0m');
    expect(formatDuration(5_400_000)).toBe('1h30m');
  });
});

describe('createProgress on a TTY', () => {
  it('redraws a single line carrying every counter', () => {
    const { written, stream } = sink(true);
    let clock = 0;
    const progress = createProgress({ stream, now: () => clock });

    clock = 60_000;
    progress.update({ items: 42904, done: 187, known: 301, requests: 2140 });

    const line = written.join('');
    expect(line).toContain('\r');
    expect(line).toContain('42,904 repos');
    expect(line).toContain('window 187/301');
    expect(line).toContain('2,140 req');
    expect(line).toContain('eta');
  });

  it('throttles redraws so a fast loop does not thrash the terminal', () => {
    const { written, stream } = sink(true);
    let clock = 0;
    const progress = createProgress({ stream, now: () => clock, redrawMs: 100 });

    progress.update({ items: 1, done: 1, known: 10, requests: 1 });
    const afterFirst = written.length;
    clock = 50;
    progress.update({ items: 2, done: 2, known: 10, requests: 2 });
    expect(written.length).toBe(afterFirst);

    clock = 150;
    progress.update({ items: 3, done: 3, known: 10, requests: 3 });
    expect(written.length).toBeGreaterThan(afterFirst);
  });

  it('clears the line when done so the shell prompt is not left mid-bar', () => {
    const { written, stream } = sink(true);
    const progress = createProgress({ stream, now: () => 0 });
    progress.update({ items: 1, done: 1, known: 1, requests: 1 });
    progress.done();
    expect(written.at(-1)).toContain('\n');
  });
});

describe('createProgress without a TTY', () => {
  it('logs instead of drawing, and emits no escape codes', () => {
    const { written, stream } = sink(false);
    const log = { info: vi.fn() };
    let clock = 0;
    const progress = createProgress({ stream, log, now: () => clock, intervalMs: 15_000 });

    progress.update({ items: 10, done: 1, known: 10, requests: 5 });
    expect(log.info).toHaveBeenCalledTimes(1);

    clock = 5_000; // inside the interval
    progress.update({ items: 20, done: 2, known: 10, requests: 9 });
    expect(log.info).toHaveBeenCalledTimes(1);

    clock = 20_000; // past it
    progress.update({ items: 30, done: 3, known: 10, requests: 14 });
    expect(log.info).toHaveBeenCalledTimes(2);

    expect(written).toEqual([]);
    expect(log.info.mock.calls[0]![0]).toMatchObject({ repos: 10, windows_done: 1 });
  });
});
