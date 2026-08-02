import { FALLBACK_KIND, allValues, isValue } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { DECLARED_DERIVED } from './derived';
import { DECLARED_KINDS } from './kind';
import { DECLARED_RUNTIMES } from './runtime';

/**
 * The safety net that replaces the compile-time union check (§6, and the design note in
 * docs/superpowers/specs/2026-08-01-taxonomy-yaml-design.md).
 *
 * The vocabulary is data now, so a typo in a rule table is no longer a type error. It is a
 * document nothing can filter on and a chip that never appears. This suite makes it a test
 * failure instead.
 *
 * `kind`, `domains` and `runtime` are checked one way only — declared values must exist in
 * the file, but the file may legitimately hold values no pass-1 rule emits, because pass 3
 * (the LLM) can produce them. The derived families are checked both ways: every value in
 * the file must be reachable, since nothing but these rules ever assigns them.
 */
describe('rule outputs are pinned to taxonomy.yaml', () => {
  it('every kind a rule can emit exists in the file', () => {
    for (const kind of DECLARED_KINDS) {
      expect(isValue('kind', kind), `kind rules emit "${kind}"`).toBe(true);
    }
  });

  it('the LLM fallback kind exists in the file', () => {
    expect(isValue('kind', FALLBACK_KIND)).toBe(true);
  });

  it('every runtime a rule can emit exists in the file', () => {
    for (const runtime of DECLARED_RUNTIMES) {
      expect(isValue('runtime', runtime), `runtime rules emit "${runtime}"`).toBe(true);
    }
  });

  for (const [familyId, declared] of Object.entries(DECLARED_DERIVED)) {
    it(`${familyId} declares exactly the values in the file`, () => {
      expect([...declared].sort()).toEqual(allValues(familyId).map((value) => value.id).sort());
    });
  }
});
