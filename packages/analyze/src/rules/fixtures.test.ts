import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDerived, type DerivedInput } from './derived';
import { classifyDomains, classifyKind, k8sRelevance, type RuleInput } from './kind';
import { classifyRuntime } from './runtime';

/**
 * Fixtures are literally cache entries (§13) — real cached payloads, committed. A new
 * classification rule requires a fixture proving it, and this suite runs every fixture
 * through every pass-1 classifier.
 *
 * Two fixtures are marked `synthetic`: they encode a licence and marker combination the
 * real corpus does not yet contain. They are named `_synthetic__*` so it is obvious in a
 * directory listing which entries are not real cache.
 */
type Fixture = RuleInput & {
  synthetic?: boolean;
  /**
   * `tree` is deliberately omitted here: it's the same repo tree the kind and runtime rules
   * read, already carried at the fixture's top level via `RuleInput`. Duplicating it inside
   * `derived_input` would give one fact two homes that could drift apart, so it's spliced
   * back in from `fixture.tree` at the call site below instead of being repeated in fixture
   * JSON.
   */
  derived_input?: Omit<DerivedInput, 'tree'>;
  expected: {
    kind: string;
    rule: string;
    domains?: string[];
    k8s_relevance_min?: number;
    runtime?: string;
    derived?: {
      license_class: string;
      openness: string;
      maturity: string;
      governance: string;
    };
  };
};

/** Fixed so the maturity expectations above are deterministic. */
const NOW = new Date('2026-08-01T00:00:00.000Z');

const FIXTURE_DIR = new URL('../../fixtures/', import.meta.url).pathname;

const fixtures = await Promise.all(
  (await readdir(FIXTURE_DIR))
    .filter((file) => file.endsWith('.json'))
    .map(async (file) => JSON.parse(await readFile(join(FIXTURE_DIR, file), 'utf8')) as Fixture),
);

describe('pass 1 — local rules', () => {
  it('has at least one fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('has at least one real, non-synthetic fixture', () => {
    expect(fixtures.some((fixture) => fixture.synthetic !== true)).toBe(true);
  });

  for (const fixture of fixtures) {
    describe(fixture.repo, () => {
      const verdicts = classifyKind(fixture);
      const kind = verdicts[0]?.kind ?? null;

      it(`classifies as ${fixture.expected.kind} via ${fixture.expected.rule}`, () => {
        expect(verdicts[0]?.kind).toBe(fixture.expected.kind);
        expect(verdicts[0]?.rule).toBe(fixture.expected.rule);
      });

      if (fixture.expected.domains) {
        it('derives the expected domains from topics', () => {
          expect(classifyDomains(fixture).sort()).toEqual([...fixture.expected.domains!].sort());
        });
      }

      if (fixture.expected.k8s_relevance_min !== undefined) {
        it('is recognisably part of the Kubernetes ecosystem', () => {
          expect(k8sRelevance(fixture)).toBeGreaterThanOrEqual(fixture.expected.k8s_relevance_min!);
        });
      }

      if (fixture.expected.runtime) {
        it(`runs ${fixture.expected.runtime}`, () => {
          expect(classifyRuntime(fixture, kind).runtime).toBe(fixture.expected.runtime);
        });
      }

      if (fixture.expected.derived) {
        it('derives licence, openness, maturity and governance', () => {
          expect(fixture.derived_input).toBeDefined();
          expect(
            classifyDerived({ ...fixture.derived_input!, tree: fixture.tree }, NOW),
          ).toEqual(fixture.expected.derived);
        });
      }
    });
  }
});

describe('k8sRelevance', () => {
  it('demotes a repo whose only Kubernetes link is a CI manifest', () => {
    const dotfiles: RuleInput = {
      repo: 'someone/dotfiles',
      name: 'dotfiles',
      description: 'my shell config',
      topics: ['zsh', 'dotfiles'],
      tree: ['README.md', '.github/workflows/kubernetes-deploy.yml'],
      manifests: {},
      language: 'Shell',
    };
    expect(k8sRelevance(dotfiles)).toBe(0);
  });
});
