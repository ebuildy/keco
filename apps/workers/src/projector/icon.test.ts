import { describe, expect, it } from 'vitest';
import { iconDescriptor } from './icon';

const good = {
  source: 'repo-logo',
  source_url: 'https://raw.githubusercontent.com/acme/widget/main/logo.png',
  content_type: 'image/png',
  bytes: 4096,
  etag: '"v1"',
  sizes: [32, 64, 160],
  fetched_at: '2026-08-24T00:00:00.000Z',
  error: null,
};

describe('iconDescriptor', () => {
  it('carries source, provenance and freshness onto the document', () => {
    expect(iconDescriptor(good)).toEqual({
      source: 'repo-logo',
      source_url: good.source_url,
      fetched_at: good.fetched_at,
    });
  });

  it('is null when the repo has no icon.json at all', () => {
    expect(iconDescriptor(null)).toBeNull();
  });

  it('is null when the last attempt found nothing', () => {
    expect(iconDescriptor({ ...good, source: null, source_url: null, sizes: [] })).toBeNull();
  });

  // A transient failure over a still-cached icon keeps the descriptor: the bytes are there.
  it('keeps the descriptor when an error sits on top of a good icon', () => {
    expect(iconDescriptor({ ...good, error: 'fetch failed: HTTP 500' })?.source).toBe('repo-logo');
  });

  // Nothing downstream would catch a malformed descriptor: Meilisearch accepts any value and
  // the portal renders it verbatim. The write side is what guarantees read-model correctness.
  it('is null when the metadata is malformed rather than passing it through', () => {
    expect(iconDescriptor({ ...good, source: 'favicon' })).toBeNull();
    expect(iconDescriptor({ ...good, source_url: 'not a url' })).toBeNull();
    expect(iconDescriptor({ nonsense: true })).toBeNull();
  });

  it('is null when the derivatives were never written', () => {
    expect(iconDescriptor({ ...good, sizes: [] })).toBeNull();
  });
});
