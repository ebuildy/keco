import type { Cache } from '@keco/cache';
import { AnalysisSchema, FALLBACK_KIND, type Analysis } from '@keco/core';
import { classifyWithLlm, needsLlm, README_BUDGET_BYTES, type LlmDeps } from './llm';
import { classifyDerived, type DerivedInput } from './rules/derived';
import { classifyDomains, classifyKind, k8sRelevance, type RuleInput } from './rules/kind';
import { classifyRuntime } from './rules/runtime';
import { gatherSignals } from './signals';

/**
 * One repo, analyzed (AGENTS.md §4.2). The three-pass composition: `apps/workers/src/analyzer`
 * reads the cached artifacts and calls this; everything about *how* a repo gets classified
 * lives here.
 */
export type AnalyzeInput = RuleInput & {
  content_hash: string;
  readme: string;
  /**
   * `landscape` isn't here: it comes from pass 2's `gatherSignals`, not the caller (§4.2/§4.3).
   * `readme` isn't here either — it's the top-level `readme` field above, reused for
   * `classifyDerived`'s enterprise-README check as well as for pass 3's prompt, rather than
   * duplicated on this object.
   */
  derived: Omit<DerivedInput, 'tree' | 'landscape' | 'readme'>;
};

export type AnalyzeDeps = {
  cache: Cache;
  /** The one manual TTL bypass (§4.2), forwarded to every pass-2 provider. */
  forceRefresh: string | null;
  /** `null` disables pass 3 (no ANTHROPIC_API_KEY configured) — an honest, not a fabricated, degrade. */
  llm: LlmDeps | null;
  now?: Date;
};

export async function analyzeRepo(input: AnalyzeInput, deps: AnalyzeDeps): Promise<Analysis> {
  const now = deps.now ?? new Date();

  // ── pass 1 — local rules, free and deterministic (classifyDerived excepted — see below) ──
  const kindVerdicts = classifyKind(input);
  const best = kindVerdicts[0] ?? null;
  const ruleConfidence = best?.confidence ?? 0;
  const ruleDomains = classifyDomains(input);
  const runtime = classifyRuntime(input, best?.kind ?? null).runtime;
  const relevance = k8sRelevance(input);

  // ── pass 2 — external signals, always attempted, never fatal ──────────────
  const { signals, landscape, install_methods, signals_used, partial_signals } =
    await gatherSignals(
      deps.cache,
      { repo: input.repo, name: input.name, manifests: input.manifests },
      { forceRefresh: deps.forceRefresh, now },
    );

  // classifyDerived runs here, not with the rest of pass 1 above: it needs pass 2's `landscape`
  // to tell a real CNCF-hosted project from an `unknown` one.
  const derived = classifyDerived(
    { ...input.derived, readme: input.readme, tree: input.tree, landscape },
    now,
  );

  // ── pass 3 — LLM, only when pass 1 left kind or domains unsettled ─────────
  // Note the asymmetry this creates: when `ambiguous` is true only because `ruleDomains` came
  // back empty (kind confidence was already high — e.g. 0.95 from `.krew.yaml`), a successful
  // LLM verdict below still unconditionally overwrites `kind`, and `runtime` above was already
  // derived from pass-1's kind and is never recomputed against the LLM's possibly-different
  // one. This is intentional, not a bug: once the LLM is invoked at all, it owns the full
  // classification package (summary/kind/domains/confidence/needs_review) rather than just the
  // piece that triggered it — so `kind` and `runtime` do not always stay in sync outside of
  // pass 1 settling the repo alone.
  const ambiguous = needsLlm(ruleConfidence) || ruleDomains.length === 0;

  // Rules-settled repos (the majority of the corpus) still deserve a `summary` — it outranks
  // `description` in the search index's searchable attributes (§5) and shows on tool cards.
  // There is no rule-based summary generator, so the repo's own GitHub description is the
  // fallback here. Both non-LLM branches below (settled outright, or ambiguous with no LLM
  // configured) keep this value; only the LLM branches override it.
  let summary = input.description ? input.description.slice(0, 400) : '';
  let kind = best?.kind ?? FALLBACK_KIND;
  let domains = ruleDomains;
  let confidence = ruleConfidence;
  let needsReview = false;
  let method: 'rules' | 'llm' = 'rules';
  let model: string | null = null;

  if (ambiguous) {
    if (deps.llm) {
      method = 'llm';
      model = deps.llm.model;
      const verdict = await classifyWithLlm(
        {
          repo: input.repo,
          readme: input.readme.slice(0, README_BUDGET_BYTES),
          topics: input.topics,
          tree: input.tree,
          signals,
        },
        deps.llm,
      );
      if (verdict) {
        summary = verdict.summary;
        kind = verdict.kind;
        domains = verdict.domains;
        confidence = verdict.confidence;
        needsReview = verdict.needs_review;
      } else {
        // Invalid twice — the honest low-confidence answer, never a fabricated one (§4.2 pass 3).
        // A repo that stumped both rules and the LLM gets an honest "we don't know" summary,
        // not the description fallback above — that fallback is for a confident classification,
        // and this is the opposite of confident.
        summary = '';
        kind = FALLBACK_KIND;
        domains = ruleDomains.length > 0 ? ruleDomains : ['dev-experience'];
        confidence = 0.3;
        needsReview = true;
      }
    } else {
      // No ANTHROPIC_API_KEY configured: stay honest about the gap rather than silently
      // upgrading confidence pass 1 never earned.
      domains = ruleDomains.length > 0 ? ruleDomains : ['dev-experience'];
      needsReview = true;
    }
  }

  return AnalysisSchema.parse({
    repo: input.repo,
    content_hash: input.content_hash,
    summary,
    kind,
    domains,
    runtime,
    license_class: derived.license_class,
    openness: derived.openness,
    maturity: derived.maturity,
    governance: derived.governance,
    k8s_relevance: relevance,
    confidence,
    needs_review: needsReview,
    install_methods,
    signals,
    method,
    model,
    signals_used,
    partial_signals,
    analyzed_at: now.toISOString(),
  });
}
