import { describe, expect, it } from 'vitest';
import { MeilisearchApiError } from 'meilisearch';
import { searchErrorMessage } from './search';

describe('searchErrorMessage', () => {
  it('distinguishes a missing/invalid search key from an outage', () => {
    const unauthorized = new MeilisearchApiError(
      new Response(null, { status: 401 }),
      { message: 'missing authorization header', code: 'missing_authorization_header', type: 'auth', link: '' },
    );
    expect(searchErrorMessage(unauthorized)).toMatch(/not configured/i);
    expect(searchErrorMessage(unauthorized)).toContain('VITE_MEILI_SEARCH_KEY');
  });

  it('reports a generic outage for anything else', () => {
    expect(searchErrorMessage(new TypeError('Failed to fetch'))).toBe('Search is unavailable right now.');

    const serverError = new MeilisearchApiError(
      new Response(null, { status: 500 }),
      { message: 'internal', code: 'internal', type: 'internal', link: '' },
    );
    expect(searchErrorMessage(serverError)).toBe('Search is unavailable right now.');
  });
});
