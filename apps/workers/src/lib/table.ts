import type { Document } from './data-store';

/**
 * Table and NDJSON rendering, shared by every `kecoctl` command that prints a result.
 *
 * Pure: data in, strings out, no DataStore and no I/O — which is what lets a table layout be
 * tested without a backend. These strings go to **stdout**; pino keeps stderr, the same split
 * the progress bar uses. A query command's output is its result, not a log line, and `--json`
 * has to pipe into `jq` cleanly.
 *
 * Lifted out of `discovery/explore-format.ts` when the crawler's run history needed the same
 * layout. Two copies of a column-width calculation is two things to fix when a column is added.
 */

export const number = (value: unknown): string =>
  typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? '');

export const text = (value: unknown, fallback = '—'): string =>
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

/** One JSON object per line — streams into `jq` without buffering the corpus. */
export const ndjson = (rows: readonly Document[]): string =>
  rows.map((row) => JSON.stringify(row)).join('\n');
