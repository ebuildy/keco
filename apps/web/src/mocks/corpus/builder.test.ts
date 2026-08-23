import { ToolDocument, toDocumentId } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { makeTool } from './builder';

describe('makeTool', () => {
  it('derives identity from repo and produces a valid ToolDocument', () => {
    const tool = makeTool({ repo: 'derailed/k9s' });

    expect(tool.owner).toBe('derailed');
    expect(tool.name).toBe('k9s');
    expect(tool.full_name).toBe('derailed/k9s');
    expect(tool.id).toBe(toDocumentId('derailed/k9s'));
    expect(tool.repo_url).toBe('https://github.com/derailed/k9s');
    expect(() => ToolDocument.parse(tool)).not.toThrow();
  });

  it('lets overrides win over defaults', () => {
    const tool = makeTool({ repo: 'a/b', stars: 4200, kind: 'cli', domains: ['security'] });
    expect(tool.stars).toBe(4200);
    expect(tool.kind).toBe('cli');
    expect(tool.domains).toEqual(['security']);
  });

  it('derives has_scorecard from the scorecard signal unless overridden', () => {
    expect(makeTool({ repo: 'a/b' }).has_scorecard).toBe(true);
    const none = makeTool({ repo: 'a/b', signals: { scorecard: null, osv: null, dependents: null } });
    expect(none.has_scorecard).toBe(false);
  });

  it('throws on a repo with no slash', () => {
    expect(() => makeTool({ repo: 'no-slash' })).toThrow();
  });

  it('throws on a repo with too many slashes', () => {
    expect(() => makeTool({ repo: 'a/b/c' })).toThrow();
  });

  it('derives signals_used: [] when the scorecard signal is null', () => {
    const none = makeTool({ repo: 'a/b', signals: { scorecard: null, osv: null, dependents: null } });
    expect(none.signals_used).toEqual([]);
  });
});
