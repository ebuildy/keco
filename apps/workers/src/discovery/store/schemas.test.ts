import { describe, expect, it } from 'vitest';
import { KnownRepoSchema, StateDocumentSchema } from './schemas';

const state = {
  query_slug: 'kubernetes',
  query: 'kubernetes',
  started_at: '2026-08-29T03:00:00.000Z',
  updated_at: '2026-08-29T03:10:00.000Z',
  current_run_id: '01J0RUN',
  pending_windows: [{ base: 'kubernetes', stars: '>100', created: { kind: 'year', year: 2020 } }],
  completed_windows: ['kubernetes stars:>100'],
  failed_windows: [{ window: 'w', error: 'boom' }],
  repos_seen: 3,
  pages_fetched: 4,
  dropped: 0,
};

describe('StateDocumentSchema', () => {
  it('accepts a well-formed state document', () => {
    expect(StateDocumentSchema.safeParse(state).success).toBe(true);
  });

  it('backfills a counter added after the fact, so an in-flight sweep still resumes', () => {
    // Rest-destructuring to omit trips no-unused-vars; deleting is the idiom this repo lints for.
    const older: Record<string, unknown> = { ...state };
    delete older.dropped;
    const parsed = StateDocumentSchema.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.dropped).toBe(0);
  });

  it('rejects an unknown window kind rather than resuming into nonsense', () => {
    const bad = { ...state, pending_windows: [{ base: 'k', stars: '>1', created: { kind: 'aeon' } }] };
    expect(StateDocumentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a pending window with the wrong field types', () => {
    const bad = { ...state, pending_windows: [{ base: 1, stars: '>1', created: null }] };
    expect(StateDocumentSchema.safeParse(bad).success).toBe(false);
  });
});

describe('KnownRepoSchema', () => {
  it('accepts the three projected fields', () => {
    expect(
      KnownRepoSchema.safeParse({
        repo_id: 20038725,
        payload_hash: 'abc',
        first_seen_run_id: '01J0RUN',
      }).success,
    ).toBe(true);
  });

  it('rejects a row missing its hash, which would make the repo look unchanged forever', () => {
    expect(KnownRepoSchema.safeParse({ repo_id: 1, first_seen_run_id: 'r' }).success).toBe(false);
  });
});
