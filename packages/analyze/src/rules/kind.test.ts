import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDomains, classifyKind, k8sRelevance, type RuleInput } from './kind';

/**
 * Fixtures are literally cache entries (§13) — real cached payloads, committed. A new
 * classification rule requires a fixture proving it, and this suite runs every fixture.
 */
type Fixture = RuleInput & {
  expected: {
    kind: string;
    rule: string;
    domains?: string[];
    k8s_relevance_min?: number;
  };
};

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

  for (const fixture of fixtures) {
    describe(fixture.repo, () => {
      const verdicts = classifyKind(fixture);

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
