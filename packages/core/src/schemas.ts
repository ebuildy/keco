import { z } from 'zod';
import { Domains, InstallMethod, Kind } from './taxonomy';

/**
 * The two model shapes (AGENTS.md §2.6). `AnalysisSchema` is the write side's output;
 * `ToolDocument` is the flat, denormalized read model. They are deliberately different —
 * never leak the raw GitHub shape into `tools`, never store search documents in the cache.
 */

/** Proven install route. Unprovable ⇒ not listed (§6). People paste these into a terminal. */
export const InstallMethodEntry = z.object({
  method: InstallMethod,
  command: z.string().min(1),
  /** Registry entry proving this exists — the Homebrew formula, the krew manifest… */
  source_url: z.url(),
  verified_at: z.iso.datetime(),
});
export type InstallMethodEntry = z.infer<typeof InstallMethodEntry>;

export const ScorecardSignal = z.object({
  score: z.number().min(0).max(10),
  checks: z.record(z.string(), z.number()),
  fetched_at: z.iso.datetime(),
});

export const Signals = z.object({
  scorecard: ScorecardSignal.nullable().default(null),
  osv: z.object({ open_vulns: z.number().int().min(0), fetched_at: z.iso.datetime() }).nullable().default(null),
  dependents: z.number().int().min(0).nullable().default(null),
});
export type Signals = z.infer<typeof Signals>;

/** Which pass settled the classification (§4.2). Cheapest first: rules → signals → llm. */
export const AnalysisMethod = z.enum(['rules', 'signals', 'llm']);
export type AnalysisMethod = z.infer<typeof AnalysisMethod>;

/**
 * `analysis/{owner}/{repo}.json`. Every field that makes a classification explainable,
 * datable and reproducible is mandatory — a score you cannot date is a score you cannot
 * defend.
 */
export const AnalysisSchema = z.object({
  repo: z.string(),
  content_hash: z.string(),
  summary: z.string().max(400),
  kind: Kind,
  domains: Domains,
  /** Demotes courses, blogs and dotfiles that merely mention Kubernetes (§14). */
  k8s_relevance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean().default(false),
  install_methods: z.array(InstallMethodEntry).default([]),
  signals: Signals,
  method: AnalysisMethod,
  model: z.string().nullable().default(null),
  signals_used: z.array(z.string()).default([]),
  /** Providers that timed out / 404'd / rate-limited. Degrade, never fail (§4.2). */
  partial_signals: z.array(z.string()).default([]),
  analyzed_at: z.iso.datetime(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** The four axes plus their weighted total and momentum (§4.3). */
export const Score = z.object({
  popularity: z.number().min(0).max(1),
  activity: z.number().min(0).max(1),
  adoption: z.number().min(0).max(1),
  quality: z.number().min(0).max(1),
  /** Share of quality sub-signals actually present. 0.9 from four signals ≠ 0.9 from one. */
  quality_coverage: z.number().min(0).max(1),
  total: z.number().min(0).max(1),
  momentum: z.number(),
});
export type Score = z.infer<typeof Score>;

/** A document in the `tools` index. Under 8 KB — the full README stays in the cache (§5). */
export const ToolDocument = z.object({
  id: z.string(), // owner__repo — Meilisearch primary keys allow [A-Za-z0-9_-] only
  owner: z.string(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable(),
  homepage: z.url().nullable(),
  repo_url: z.url(),

  stars: z.number().int(),
  forks: z.number().int(),
  open_issues: z.number().int(),
  language: z.string().nullable(),
  license: z.string().nullable(),
  topics: z.array(z.string()),
  archived: z.boolean(),
  pushed_at: z.iso.datetime(),
  created_at: z.iso.datetime(),
  discovery_source: z.string(),

  summary: z.string(),
  kind: Kind,
  domains: Domains,
  k8s_relevance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean(),
  install_methods: z.array(InstallMethodEntry),

  score: Score,
  signals: Signals,
  has_scorecard: z.boolean(),
  has_release: z.boolean(),

  readme_excerpt: z.string(), // ~1.5 KB

  analysis_method: AnalysisMethod,
  analysis_model: z.string().nullable(),
  content_hash: z.string(),
  signals_used: z.array(z.string()),
  /** Eventual consistency is the contract (§2.7) — freshness is shown, never faked. */
  indexed_at: z.iso.datetime(),
});
export type ToolDocument = z.infer<typeof ToolDocument>;

/** A document in `repos_state`: a second read model over the same events (§5). */
export const RepoState = z.object({
  id: z.string(),
  repo: z.string(),
  phase: z.enum(['discovered', 'fetched', 'analyzed', 'projected', 'skipped', 'failed']),
  content_hash: z.string().nullable(),
  fetched_at: z.iso.datetime().nullable(),
  analyzed_at: z.iso.datetime().nullable(),
  projected_at: z.iso.datetime().nullable(),
  confidence: z.number().nullable(),
  skip_reason: z.string().nullable(),
  last_error: z.string().nullable(),
});
export type RepoState = z.infer<typeof RepoState>;

/** Meilisearch primary keys are restricted to `[A-Za-z0-9_-]`; `/` is not allowed. */
export const toDocumentId = (fullName: string): string => fullName.replace('/', '__');
export const fromDocumentId = (id: string): string => id.replace('__', '/');
