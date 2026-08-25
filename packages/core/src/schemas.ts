import { z } from 'zod';
import { Domains, InstallMethod, Kind, valueSchema } from './taxonomy';

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
  /** Where the thing executes. `unknown` until a rule proves otherwise (§6). */
  runtime: valueSchema('runtime').default('unknown'),
  /** Licence family bucketed from the SPDX id GitHub reports. */
  license_class: valueSchema('license_class').default('unknown'),
  /** Fully open vs open-core. Promoted only on positive evidence — see docs/taxonomy.md. */
  openness: valueSchema('openness').default('unknown'),
  /** How settled the project is. CNCF graduation status takes precedence when known; age and activity are the fallback heuristic otherwise. */
  maturity: valueSchema('maturity').default('unknown'),
  /** Who steers the project. Evidence-only — an org account alone proves nothing. */
  governance: valueSchema('governance').default('unknown'),
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

/**
 * The project's icon, or `null` when it has none — most of the corpus, until the crawler
 * reaches it. The bytes live in the cache and are served by `apps/api`; what the document
 * carries is only enough to know an icon *exists* (so no card fires a request that 404s) and
 * where the artwork came from.
 *
 * `source` is load-bearing: a real project mark and an org avatar are different claims, and
 * the backoffice has to be able to say which one a reader is looking at.
 */
export const IconDescriptor = z.object({
  source: z.enum(['repo-logo', 'owner-avatar']),
  /** Provenance — the URL the artwork was actually fetched from. */
  source_url: z.url(),
  fetched_at: z.iso.datetime(),
});
export type IconDescriptor = z.infer<typeof IconDescriptor>;

/**
 * The rendered icon sizes, and the only sizes `apps/api` will serve: 32 for a result card, 64
 * for its 2× source, 160 for the tool page.
 *
 * Here rather than in `@keco/cache` — beside the descriptor whose bytes they size — because
 * the portal needs this list too, and a browser bundle may not import `@keco/cache` (§7). This
 * is the same reason `MAX_TOTAL_HITS` and `isSortKey` live in this package (§11): read-side
 * vocabulary that both the browser and the server have to agree on. `packages/cache` imports
 * `IconSize` back from here to type its key builder.
 */
export const ICON_SIZES = [32, 64, 160] as const;
export type IconSize = (typeof ICON_SIZES)[number];

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
  /** Raw SPDX identifier from GitHub, verbatim (e.g. "Apache-2.0"). Bucketed into `license_class` below. */
  license: z.string().nullable(),
  /**
   * GitHub's own topics, verbatim — an unstructured tag cloud repo owners pick themselves.
   * Distinct from Keco's closed taxonomy (`kind`, `domains`, `runtime`, `license_class`,
   * `openness`, `maturity`, `governance`), which the analyzer assigns.
   */
  github_topics: z.array(z.string()),
  archived: z.boolean(),
  pushed_at: z.iso.datetime(),
  created_at: z.iso.datetime(),
  discovery_source: z.string(),

  summary: z.string(),
  kind: Kind,
  domains: Domains,
  runtime: valueSchema('runtime'),
  license_class: valueSchema('license_class'),
  openness: valueSchema('openness'),
  maturity: valueSchema('maturity'),
  governance: valueSchema('governance'),
  k8s_relevance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean(),
  install_methods: z.array(InstallMethodEntry),

  score: Score,
  signals: Signals,
  has_scorecard: z.boolean(),
  has_release: z.boolean(),

  readme_excerpt: z.string(), // ~1.5 KB
  icon: IconDescriptor.nullable(),

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
