import type { CountRow, ListResult } from './explore';
import { formatDuration, ndjson, number, table, text } from '../lib/table';

export { formatDuration, ndjson, table };

/**
 * Rendering for the explore commands. Pure: data in, strings out, no DataStore and no I/O —
 * which is what lets the table layout be tested without a backend.
 *
 * These strings go to **stdout**; pino keeps stderr, the same split the progress bar already
 * uses. A query command's output is its result, not a log line, and `--json` has to pipe into
 * `jq` cleanly.
 */

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
