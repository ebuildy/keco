import { AnalysisSchema, FALLBACK_KIND, type Analysis } from '@keco/core';

/**
 * Pass 3 — the LLM fallback (AGENTS.md §4.2). It runs only when the rules and signals
 * left the repo ambiguous (confidence < 0.7), sees a bounded context, and must return
 * structured output validated by AnalysisSchema. Free text never leaves the analyzer.
 */
export const CONFIDENCE_THRESHOLD = 0.7;
export const README_BUDGET_BYTES = 8 * 1024;

export type LlmInput = {
  repo: string;
  readme: string;
  topics: string[];
  tree: string[];
  signals: Record<string, unknown>;
};

export const needsLlm = (confidence: number): boolean => confidence < CONFIDENCE_THRESHOLD;

/** Invalid output → retry once → fall back. Never let a bad completion abort a run. */
export function fallbackAnalysis(repo: string, contentHash: string, now = new Date()): Analysis {
  return AnalysisSchema.parse({
    repo,
    content_hash: contentHash,
    summary: '',
    kind: FALLBACK_KIND,
    domains: ['dev-experience'],
    k8s_relevance: 0.3,
    confidence: 0.3,
    needs_review: true,
    install_methods: [],
    signals: { scorecard: null, osv: null, dependents: null },
    method: 'llm',
    model: null,
    signals_used: [],
    partial_signals: [],
    analyzed_at: now.toISOString(),
  });
}

/**
 * TODO(analyzer): call Anthropic with README (first 8 KB), topics, tree and pass-2 signals,
 * requiring structured output validated by AnalysisSchema; retry once on invalid output,
 * then `fallbackAnalysis`. Model comes from ANALYZER_MODEL.
 */
export async function classifyWithLlm(_input: LlmInput): Promise<Analysis | null> {
  throw new Error('not implemented: analyzer pass 3 (see AGENTS.md §4.2)');
}
