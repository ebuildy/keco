import { describe, expect, it } from 'vitest';
import { makeTool } from '../mocks/corpus/builder';
import { taxonomyLinks } from './tool-taxonomy';

const tool = (overrides: Parameters<typeof makeTool>[0]) => makeTool(overrides);

describe('taxonomyLinks', () => {
  it('reads what it is, what it solves, where it runs and how far along it is', () => {
    const links = taxonomyLinks(
      tool({
        repo: 'ahmetb/kubectx',
        kind: 'kubectl-plugin',
        domains: ['dev-experience'],
        runtime: 'workstation',
        maturity: 'established',
      }),
    );

    expect(links.map((link) => link.id)).toEqual([
      'kind:kubectl-plugin',
      'domains:dev-experience',
      'runtime:workstation',
      'maturity:established',
    ]);
  });

  it('labels every chip from the taxonomy rather than printing the id', () => {
    const [kind] = taxonomyLinks(tool({ repo: 'derailed/k9s', kind: 'kubectl-plugin' }));
    expect(kind!.label).toBe('kubectl plugin');
    expect(kind!.familyLabel).toBe('Kind');
    expect(kind!.description).not.toBe('');
  });

  it('links each value to search using the family parameter', () => {
    const links = taxonomyLinks(
      tool({ repo: 'derailed/k9s', kind: 'cli', domains: ['dev-experience', 'troubleshooting'] }),
    );

    expect(links.map((link) => link.href)).toContain('/search?kind=cli');
    expect(links.map((link) => link.href)).toContain('/search?domain=troubleshooting');
  });

  it('keeps the document order of a multi-value family', () => {
    const links = taxonomyLinks(
      tool({ repo: 'cilium/cilium', domains: ['networking', 'security', 'observability'] }),
    );

    expect(links.filter((link) => link.familyId === 'domains').map((link) => link.valueId)).toEqual(
      ['networking', 'security', 'observability'],
    );
  });

  it('never renders a hidden value', () => {
    // `unknown` is a real answer (§6) — "not enough evidence to say where it runs" is not a
    // category anybody browses, and a chip for it would link to exactly that.
    const links = taxonomyLinks(
      tool({ repo: 'mockcorp/bare', kind: 'cli', runtime: 'unknown', maturity: 'unknown' }),
    );

    expect(links.map((link) => link.familyId)).toEqual(['kind', 'domains']);
  });

  it('drops a value that is not in the vocabulary at all', () => {
    const links = taxonomyLinks(
      tool({ repo: 'mockcorp/stale', kind: 'cli', domains: ['no-such-domain'] }),
    );

    expect(links.map((link) => link.familyId)).not.toContain('domains');
  });
});
