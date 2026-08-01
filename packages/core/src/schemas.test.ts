import { describe, expect, it } from 'vitest';
import { AnalysisSchema, ToolDocument } from './schemas';

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
});

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
});
