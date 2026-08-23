import { toDocumentId, type Signals, type ToolDocument } from '@keco/core';

/**
 * Mock fixture builder — development and test only (see the design spec's governing
 * invariant). Nothing outside `main.tsx`'s dev branch and test files may import this.
 *
 * One complete, schema-valid ToolDocument so a fixture is an override, not forty repeated
 * fields. Identity is derived from `repo` so `id`, `full_name` and `repo_url` cannot drift
 * apart across thirty hand-written entries — `repo` is validated to be exactly two
 * non-empty, slash-free segments, so a malformed fixture fails loudly at module load
 * instead of silently producing a document whose identity fields disagree with each other.
 */
export type ToolOverrides = Partial<Omit<ToolDocument, 'id' | 'owner' | 'name' | 'full_name'>> & {
  repo: string;
};

const DEFAULT_SIGNALS: Signals = {
  scorecard: { score: 7.2, checks: { 'Code-Review': 8, 'CI-Tests': 10, Maintained: 9 }, fetched_at: '2026-08-20T00:00:00.000Z' },
  osv: { open_vulns: 0, fetched_at: '2026-08-20T00:00:00.000Z' },
  dependents: 120,
};

export function makeTool(overrides: ToolOverrides): ToolDocument {
  const { repo, ...rest } = overrides;
  const segments = repo.split('/');
  const [owner, name] = segments;
  if (segments.length !== 2 || !owner || !name) {
    throw new Error(`makeTool: repo must be "owner/name", got ${JSON.stringify(repo)}`);
  }
  const signals = rest.signals ?? DEFAULT_SIGNALS;

  return {
    id: toDocumentId(repo),
    owner,
    name,
    full_name: repo,
    description: `${name} — a Kubernetes ecosystem project.`,
    homepage: null,
    repo_url: `https://github.com/${repo}`,

    stars: 1200,
    forks: 140,
    open_issues: 30,
    language: 'Go',
    license: 'Apache-2.0',
    github_topics: ['kubernetes'],
    archived: false,
    pushed_at: '2026-08-01T00:00:00.000Z',
    created_at: '2019-03-01T00:00:00.000Z',
    discovery_source: 'mock',

    summary: `${name} is a Kubernetes ecosystem project used for mock development.`,
    kind: 'service',
    // taxonomy.yaml declares domains min: 1 — an empty array fails ToolDocument.parse.
    domains: ['dev-experience'],
    runtime: 'in-cluster',
    license_class: 'permissive',
    openness: 'fully-open',
    maturity: 'established',
    governance: 'community',
    k8s_relevance: 0.9,
    confidence: 0.85,
    needs_review: false,
    install_methods: [],

    score: {
      popularity: 0.55,
      activity: 0.7,
      adoption: 0.4,
      quality: 0.75,
      quality_coverage: 0.8,
      total: 0.6,
      momentum: 0.5,
    },
    signals,
    has_scorecard: signals.scorecard !== null,
    has_release: true,

    readme_excerpt: `# ${name}\n\nMock README excerpt for ${repo}.`,

    analysis_method: 'rules',
    analysis_model: null,
    content_hash: `mock-${toDocumentId(repo)}`,
    signals_used: signals.scorecard ? ['scorecard'] : [],
    indexed_at: '2026-08-23T00:00:00.000Z',

    ...rest,
  };
}
