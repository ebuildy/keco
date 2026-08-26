import { describe, expect, it } from 'vitest';
import { ToolDocument } from '@keco/core';
import { MOCK_CORPUS, MOCK_SENTINEL } from '../src/mocks/corpus';
import { expectedCorpusJson, readCorpusJson, serialiseCorpus } from './emit-mock-corpus';

describe('serialiseCorpus', () => {
  it('rejects a document that is not a valid ToolDocument', () => {
    expect(() => serialiseCorpus([{ id: 'nope' }])).toThrow(/document 0 is not a valid ToolDocument/);
  });

  it('rejects a document that does not carry the mock sentinel', () => {
    const stray = { ...MOCK_CORPUS[0], discovery_source: 'github-search' };
    expect(() => serialiseCorpus([stray])).toThrow(/must carry the sentinel/);
  });

  it('is deterministic', () => {
    expect(serialiseCorpus(MOCK_CORPUS)).toBe(serialiseCorpus(MOCK_CORPUS));
  });
});

describe('infra/mock/corpus.json', () => {
  /**
   * The artifact is committed so `mise run mock:seed` works without building the portal, which
   * means it can go stale the moment anyone edits `curated.ts` or `generate.ts`. This is the
   * pin that turns that into a failed `mise run ci` instead of a seeded index that silently
   * disagrees with what `mise run web:mock` serves.
   */
  it('matches what the generator emits today', () => {
    expect(readCorpusJson()).toBe(expectedCorpusJson());
  });

  it('parses back into the same documents the portal mock serves', () => {
    const documents = ToolDocument.array().parse(JSON.parse(readCorpusJson() ?? 'null'));
    expect(documents).toHaveLength(MOCK_CORPUS.length);
    expect(documents.every((document) => document.discovery_source === MOCK_SENTINEL)).toBe(true);
  });
});
