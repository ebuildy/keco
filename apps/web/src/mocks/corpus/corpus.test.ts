import { ToolDocument } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { MOCK_CORPUS, MOCK_SENTINEL } from './index';

describe('the mock corpus', () => {
  it('is large enough to paginate', () => {
    expect(MOCK_CORPUS.length).toBeGreaterThan(250);
  });

  it('has a document for every curated and generated entry, with unique ids', () => {
    expect(new Set(MOCK_CORPUS.map((tool) => tool.id)).size).toBe(MOCK_CORPUS.length);
  });

  it('validates every document against the read model schema', () => {
    for (const tool of MOCK_CORPUS) {
      const result = ToolDocument.safeParse(tool);
      if (!result.success) {
        throw new Error(`${tool.full_name} is not a valid ToolDocument: ${result.error.message}`);
      }
    }
  });

  it('covers the states the UI has to handle', () => {
    expect(MOCK_CORPUS.some((tool) => tool.archived)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.needs_review)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.signals.scorecard === null)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.install_methods.length === 0)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.install_methods.length > 1)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.governance === 'unknown')).toBe(true);
  });

  it('exposes a distinctive sentinel for the production-build scan', () => {
    expect(MOCK_SENTINEL).toBe('KECO_MOCK_CORPUS_DO_NOT_SHIP');
  });
});
