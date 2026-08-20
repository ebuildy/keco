import { describe, expect, it } from 'vitest';
import { formatUtcDate } from './dates';

describe('formatUtcDate', () => {
  it('formats an instant near midnight UTC the same regardless of the host timezone', () => {
    // Demonstrated bug: toDateString() renders "Thu Aug 20 2026" under TZ=UTC and
    // "Wed Aug 19 2026" under TZ=America/Los_Angeles for this same instant.
    expect(formatUtcDate('2026-08-20T02:00:00Z')).toBe('Aug 20, 2026');
  });

  it('formats an ordinary instant', () => {
    expect(formatUtcDate('2026-01-05T18:30:00Z')).toBe('Jan 5, 2026');
  });
});
