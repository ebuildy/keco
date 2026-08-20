/**
 * Date formatting for prerendered pages (AGENTS.md §9).
 *
 * `toDateString()` and `toLocaleDateString()` without an explicit `timeZone` both read the
 * *host's* local offset. The prerender build runs on one machine (its CI runner's TZ, usually
 * UTC) and the hydrating browser runs on the reader's — for a `pushed_at` near midnight UTC
 * those two disagree on the calendar day, so the markup React hydrates over does not match
 * what it renders client-side and React discards the prerendered DOM. Pin the zone so the
 * same ISO instant always formats identically wherever it runs.
 */
export const formatUtcDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
