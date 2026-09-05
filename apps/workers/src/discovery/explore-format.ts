import type { Document } from '../lib/data-store';
import type { CountRow, ListResult } from './explore';

/**
 * Rendering for the explore commands. Pure: data in, strings out, no DataStore and no I/O —
 * which is what lets the table layout be tested without a backend.
 *
 * These strings go to **stdout**; pino keeps stderr, the same split the progress bar already
 * uses. A query command's output is its result, not a log line, and `--json` has to pipe into
 * `jq` cleanly.
 */

const number = (value: unknown): string =>
  typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? '');

const text = (value: unknown, fallback = '—'): string =>
  typeof value === 'string' && value !== '' ? value : fallback;

/** A column is right-aligned when every one of its cells is a number. */
const isNumeric = (cells: readonly string[]): boolean =>
  cells.every((cell) => /^[\d,]*$/.test(cell));

export function table(rows: readonly Record<string, string>[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const alignRight = columns.map(
    (column) =>
      isNumeric(rows.map((row) => row[column] ?? '')) &&
      rows.some((row) => (row[column] ?? '') !== ''),
  );

  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (alignRight[i] === true ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();

  return [render(columns), ...rows.map((row) => render(columns.map((c) => row[c] ?? '')))].join('\n');
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

const shortTime = (iso: unknown): string =>
  typeof iso === 'string' && iso !== '' ? iso.slice(0, 16).replace('T', ' ') : '—';

const relative = (iso: unknown, now: Date): string => {
  if (typeof iso !== 'string' || iso === '') return '—';
  const ms = now.getTime() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(0, Math.floor(ms / 60_000))}m ago`;
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export function formatCount(rows: readonly CountRow[]): string {
  if (rows.length === 0) {
    return 'no discovery data — run `kecoctl discovery sweep --query <keyword>` first';
  }
  const body = table(
    rows.map((row) => ({
      QUERY: row.query,
      REPOS: number(row.repos),
      RUNS: number(row.runs),
      // Pending windows is what says whether a sweep finished or is mid-resume, so it earns
      // a column rather than living behind a flag.
      'PENDING WINDOWS': number(row.pending_windows),
      'LAST SWEEP': row.last_run === null ? '—' : shortTime(row.last_run.started_at),
      OUTCOME: row.last_run?.outcome ?? '—',
    })),
  );
  if (rows.length === 1) return body;
  const totals = rows.reduce(
    (acc, row) => ({ repos: acc.repos + row.repos, runs: acc.runs + row.runs }),
    { repos: 0, runs: 0 },
  );
  return `${body}\n\ntotals  ${number(totals.repos)} repos, ${number(totals.runs)} runs`;
}

const showing = (result: ListResult): string =>
  result.rows.length < result.total
    ? `\n\nshowing ${number(result.rows.length)} of ${number(result.total)} — raise with --limit, or pipe --json`
    : '';

export function formatRuns(result: ListResult): string {
  if (result.rows.length === 0) return 'no runs yet';
  const body = table(
    result.rows.map((row) => ({
      STARTED: shortTime(row.started_at),
      DUR: formatDuration(typeof row.duration_ms === 'number' ? row.duration_ms : null),
      OUTCOME: text(row.outcome),
      NEW: number(row.repos_new),
      CHANGED: number(row.repos_changed),
      PAGES: number(row.pages_fetched),
      WINDOWS: `${number(row.windows_completed)}${
        typeof row.windows_failed === 'number' && row.windows_failed > 0
          ? ` (${number(row.windows_failed)} failed)`
          : ''
      }`,
    })),
  );
  return body + showing(result);
}

export function formatRepos(result: ListResult, now = new Date()): string {
  if (result.rows.length === 0) return 'no repos discovered yet';
  const body = table(
    result.rows.map((row) => ({
      STARS: number(row.stars),
      REPO: text(row.full_name),
      LANG: text(row.language),
      PUSHED: relative(row.pushed_at, now),
    })),
  );
  return body + showing(result);
}

/** One JSON object per line — streams into `jq` without buffering the corpus. */
export const ndjson = (rows: readonly Document[]): string =>
  rows.map((row) => JSON.stringify(row)).join('\n');
