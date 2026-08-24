import { describe, expect, it } from 'vitest';
import { editDistance, suggestQueries, vocabulary } from './spelling';

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    expect(editDistance('helm', 'helm')).toBe(0);
  });

  it('counts substitutions, insertions and deletions', () => {
    expect(editDistance('netwoking', 'networking')).toBe(1);
    expect(editDistance('observabilty', 'observability')).toBe(1);
    expect(editDistance('kat', 'cat')).toBe(1);
  });

  it('abandons early past the bound rather than reporting a real distance', () => {
    // The contract is "> max", not the true distance — callers only ever compare against max.
    expect(editDistance('storage', 'ai-ml', 2)).toBeGreaterThan(2);
  });

  it('rejects on length difference alone without doing the work', () => {
    expect(editDistance('a', 'abcdefghij', 2)).toBeGreaterThan(2);
  });
});

describe('vocabulary', () => {
  it('splits compound ids and labels into words', () => {
    const words = vocabulary();

    expect(words).toContain('helm');
    expect(words).toContain('chart');
    expect(words).toContain('observability');
  });

  it('excludes hidden values such as `unknown`, which never reach the UI (§6)', () => {
    expect(vocabulary()).not.toContain('unknown');
  });

  it('excludes words too short to match meaningfully', () => {
    expect(vocabulary().every((word) => word.length >= 4)).toBe(true);
  });
});

describe('suggestQueries', () => {
  it('corrects a mangled taxonomy word', () => {
    expect(suggestQueries('observabilty')).toContain('observability');
  });

  it('corrects one word and leaves the rest of the query intact', () => {
    expect(suggestQueries('netwoking operator')).toContain('networking operator');
  });

  it('never suggests the query it was given', () => {
    expect(suggestQueries('networking')).not.toContain('networking');
  });

  it('suggests nothing for a correctly spelled single word', () => {
    // `policy` is real vocabulary, so there is no spelling to fix, and a one-word query has
    // nothing to relax. Nudging it to a near neighbour would be confident nonsense — the
    // right answer is silence, which is also what §6 says about unprovable claims.
    expect(suggestQueries('policy')).toEqual([]);
  });

  it('offers each term alone for a multi-word query, so one junk word is recoverable', () => {
    const candidates = suggestQueries('ingress zzzzqqq');

    expect(candidates).toContain('ingress');
  });

  it('does not offer a single-term relaxation for a single-term query', () => {
    // There is nothing to drop, and re-offering the same word would be a no-op suggestion.
    expect(suggestQueries('zzzzqqq')).not.toContain('zzzzqqq');
  });

  it('is empty for an empty query', () => {
    expect(suggestQueries('')).toEqual([]);
    expect(suggestQueries('   ')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(suggestQueries('netwoking storag policy backup', 2)).toHaveLength(2);
  });

  it('does not correct words too short to correct safely', () => {
    // At three characters nearly everything is within two edits of everything else.
    expect(suggestQueries('cli')).toEqual([]);
  });
});
