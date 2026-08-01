import { describe, expect, it } from 'vitest';
import { allValues } from './taxonomy';
import { AnalysisSchema, ToolDocument } from './schemas';

/** The five families added on top of the pre-existing `kind` / `domains` / `install_methods`. */
type DerivedFamily = 'runtime' | 'license_class' | 'openness' | 'maturity' | 'governance';
const DERIVED_FAMILIES: DerivedFamily[] = [
  'runtime',
  'license_class',
  'openness',
  'maturity',
  'governance',
];

/**
 * Another family to draw an invalid, but taxonomy-real, cross-family value from — proves the
 * schema wires each field to its own family rather than a copy-pasted neighbour. Deliberately
 * avoids `'unknown'` (the sentinel every family accepts) and `'source-available'` (declared by
 * both `license_class` and `openness`, so it would pass either).
 */
const FOREIGN_FAMILY: Record<DerivedFamily, string> = {
  runtime: 'license_class',
  license_class: 'runtime',
  openness: 'license_class',
  maturity: 'runtime',
  governance: 'openness',
};

/** First non-`unknown` value declared for a family — real, and never drifts from the YAML. */
const realValue = (familyId: string): string =>
  allValues(familyId).find((v) => v.id !== 'unknown')!.id;

/** Shallow omit that keeps the fixture's own type — no `any`, no unused destructured binding. */
function omit<T extends Record<string, unknown>, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const rest: Partial<T> = { ...obj };
  delete rest[key];
  return rest as Omit<T, K>;
}

const analysis = {
  repo: 'cert-manager/cert-manager',
  content_hash: 'abc123',
  summary: 'TLS certificate management for Kubernetes.',
  kind: 'operator',
  domains: ['security'],
  k8s_relevance: 0.9,
  confidence: 0.95,
  signals: { scorecard: null, osv: null, dependents: null },
  method: 'rules',
  analyzed_at: '2026-08-01T00:00:00.000Z',
};

describe('AnalysisSchema', () => {
  it('defaults every derived family to unknown', () => {
    const parsed = AnalysisSchema.parse(analysis);
    expect(parsed.runtime).toBe('unknown');
    expect(parsed.license_class).toBe('unknown');
    expect(parsed.openness).toBe('unknown');
    expect(parsed.maturity).toBe('unknown');
    expect(parsed.governance).toBe('unknown');
  });

  it('accepts values declared in the taxonomy', () => {
    const parsed = AnalysisSchema.parse({ ...analysis, runtime: 'in-cluster', maturity: 'cncf-graduated' });
    expect(parsed.runtime).toBe('in-cluster');
    expect(parsed.maturity).toBe('cncf-graduated');
  });

  it('rejects a value absent from the taxonomy', () => {
    expect(() => AnalysisSchema.parse({ ...analysis, runtime: 'in-the-cloud' })).toThrow();
    expect(() => AnalysisSchema.parse({ ...analysis, kind: 'wasm-module' })).toThrow();
  });

  it('rejects more than three domains', () => {
    expect(() =>
      AnalysisSchema.parse({ ...analysis, domains: ['security', 'policy', 'storage', 'cost'] }),
    ).toThrow();
  });

  describe.each(DERIVED_FAMILIES)('%s', (familyId) => {
    const ownValue = realValue(familyId);
    const foreignFamily = FOREIGN_FAMILY[familyId];
    const foreignValue = realValue(foreignFamily);

    it(`accepts its own family's value (${ownValue})`, () => {
      const parsed = AnalysisSchema.parse({ ...analysis, [familyId]: ownValue });
      expect(parsed[familyId]).toBe(ownValue);
    });

    // The important half: a value that is real, just for the wrong family — this is what a
    // swapped `valueSchema('...')` argument between two of these five near-identical lines
    // would let through, and a bare 'unknown' assertion cannot catch.
    it(`rejects a ${foreignFamily} value (${foreignValue})`, () => {
      expect(() => AnalysisSchema.parse({ ...analysis, [familyId]: foreignValue })).toThrow();
    });
  });
});

/** A complete, valid `tools` document — hand-built because the projector doesn't exist yet. */
const toolDocument = {
  id: 'cert-manager__cert-manager',
  owner: 'cert-manager',
  name: 'cert-manager',
  full_name: 'cert-manager/cert-manager',
  description: 'X.509 certificate management for Kubernetes.',
  homepage: 'https://cert-manager.io',
  repo_url: 'https://github.com/cert-manager/cert-manager',

  stars: 12000,
  forks: 1500,
  open_issues: 200,
  language: 'Go',
  license: 'Apache-2.0',
  github_topics: ['kubernetes', 'certificates', 'tls'],
  archived: false,
  pushed_at: '2026-07-01T00:00:00.000Z',
  created_at: '2016-01-01T00:00:00.000Z',
  discovery_source: 'topic:kubernetes',

  summary: 'TLS certificate management for Kubernetes.',
  kind: 'operator',
  domains: ['security'],
  runtime: 'in-cluster',
  license_class: 'permissive',
  openness: 'fully-open',
  maturity: 'cncf-graduated',
  governance: 'foundation',
  k8s_relevance: 0.9,
  confidence: 0.95,
  needs_review: false,
  install_methods: [],

  score: {
    popularity: 0.8,
    activity: 0.7,
    adoption: 0.6,
    quality: 0.9,
    quality_coverage: 1,
    total: 0.75,
    momentum: 0.1,
  },
  signals: { scorecard: null, osv: null, dependents: null },
  has_scorecard: false,
  has_release: true,

  readme_excerpt: 'cert-manager automates the management and issuance of TLS certificates.',

  analysis_method: 'rules',
  analysis_model: null,
  content_hash: 'abc123',
  signals_used: [],
  indexed_at: '2026-08-01T00:00:00.000Z',
};

describe('ToolDocument', () => {
  it('carries github_topics, not topics', () => {
    const shape = ToolDocument.shape;
    expect(shape).toHaveProperty('github_topics');
    expect(shape).not.toHaveProperty('topics');
  });

  it('requires the five new family fields', () => {
    for (const field of ['runtime', 'license_class', 'openness', 'maturity', 'governance']) {
      expect(ToolDocument.shape).toHaveProperty(field);
    }
  });

  it('parses a complete document', () => {
    expect(() => ToolDocument.parse(toolDocument)).not.toThrow();
  });

  it.each(DERIVED_FAMILIES)('requires %s — parse fails without it', (field) => {
    expect(() => ToolDocument.parse(omit(toolDocument, field))).toThrow();
  });
});
