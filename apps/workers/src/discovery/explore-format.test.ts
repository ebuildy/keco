import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration, formatRepos, formatRuns, ndjson, table } from './explore-format';

describe('table', () => {
  it('pads columns to the widest cell, including the header', () => {
    const lines = table([{ NAME: 'a', N: '1' }, { NAME: 'bbbb', N: '22' }]).split('\n');
    expect(lines[0]).toBe('NAME   N');
    expect(lines[1]).toBe('a      1');
    expect(lines[2]).toBe('bbbb  22');
  });

  it('right-aligns numeric columns so digits line up', () => {
    const lines = table([{ N: '1' }, { N: '1000' }]).split('\n');
    expect(lines[1]).toBe('   1');
    expect(lines[2]).toBe('1000');
  });

  it('returns an empty string for no rows, so a caller can print its own message', () => {
    expect(table([])).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders hours and minutes', () => {
    expect(formatDuration(72 * 60 * 1000)).toBe('1h12m');
  });

  it('renders minutes alone under an hour', () => {
    expect(formatDuration(58 * 60 * 1000)).toBe('58m');
  });

  it('renders seconds under a minute, so a fast run is not reported as 0m', () => {
    expect(formatDuration(4_000)).toBe('4s');
  });

  it('renders a dash for a run that has not ended', () => {
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatCount', () => {
  it('renders one row per query with thousands separators', () => {
    const out = formatCount([
      {
        query: 'kubernetes',
        query_slug: 'kubernetes',
        repos: 31204,
        runs: 47,
        pending_windows: 118,
        last_run: { run_id: 'R', started_at: '2026-08-28T03:14:00.000Z', outcome: 'complete' },
      },
    ]);
    expect(out).toContain('31,204');
    expect(out).toContain('kubernetes');
    expect(out).toContain('complete');
  });

  it('says so plainly when nothing has been swept', () => {
    expect(formatCount([])).toMatch(/no discovery data/i);
  });
});

describe('formatRuns', () => {
  const run = {
    run_id: 'R1',
    started_at: '2026-08-28T03:14:00.000Z',
    duration_ms: 72 * 60 * 1000,
    outcome: 'complete',
    repos_new: 1204,
    repos_changed: 8891,
    pages_fetched: 742,
    windows_completed: 318,
    windows_failed: 0,
  };

  it('shows the numbers the history exists to answer', () => {
    const out = formatRuns({ rows: [run], total: 1 });
    expect(out).toContain('1,204'); // new repos
    expect(out).toContain('742'); // GitHub Search calls
    expect(out).toContain('1h12m'); // duration
  });

  it('adds a showing-N-of-M line only when the list was capped', () => {
    expect(formatRuns({ rows: [run], total: 1 })).not.toMatch(/showing/);
    expect(formatRuns({ rows: [run], total: 47 })).toMatch(/showing 1 of 47/);
  });

  it('says so plainly when there are no runs', () => {
    expect(formatRuns({ rows: [], total: 0 })).toMatch(/no runs/i);
  });
});

describe('formatRepos', () => {
  it('renders stars, name, language and a relative push time', () => {
    const out = formatRepos(
      { rows: [{ full_name: 'a/one', stars: 112034, language: 'Go', pushed_at: '2026-08-27T00:00:00.000Z' }], total: 1 },
      new Date('2026-08-29T00:00:00.000Z'),
    );
    expect(out).toContain('112,034');
    expect(out).toContain('a/one');
    expect(out).toContain('2d ago');
  });
});

describe('ndjson', () => {
  it('emits one JSON object per line', () => {
    expect(ndjson([{ a: 1 }, { a: 2 }])).toBe('{"a":1}\n{"a":2}');
  });

  it('emits nothing for no rows, so a pipe sees an empty stream', () => {
    expect(ndjson([])).toBe('');
  });
});
