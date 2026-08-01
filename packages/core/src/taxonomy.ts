import { z } from 'zod';

/**
 * Closed vocabulary (AGENTS.md §6). Adding a value is a deliberate PR with rationale
 * in docs/taxonomy.md — never an ad-hoc string at a call site.
 *
 * Two axes, never one: `kind` is what the artifact *is*, `domains` is what it solves.
 * Cilium is a controller AND networking; a flat category list cannot say that.
 */

/** What the artifact is. Exactly one per tool. */
export const KINDS = [
  'cli',
  'kubectl-plugin',
  'operator',
  'controller',
  'helm-chart',
  'crd-library',
  'admission-webhook',
  'distribution',
  'dashboard-ui',
  'library-sdk',
  'terraform-provider',
  'ide-extension',
  'service',
  'learning-resource',
] as const;

/** What problem it solves. One to three per tool. */
export const DOMAINS = [
  'networking',
  'security',
  'policy',
  'storage',
  'observability',
  'ci-cd',
  'gitops',
  'packaging',
  'autoscaling',
  'cost',
  'multi-cluster',
  'backup-dr',
  'service-mesh',
  'dev-experience',
  'testing',
  'ai-ml',
  'edge',
  'troubleshooting',
] as const;

/** How you actually get it. Detected and proven, never guessed. */
export const INSTALL_METHODS = [
  'brew',
  'mise',
  'asdf',
  'krew',
  'helm',
  'kubectl-apply',
  'go-install',
  'cargo',
  'npm',
  'pip',
  'nix',
  'arkade',
  'apt',
  'container-image',
  'curl-script',
  'github-release',
  'operator-hub',
] as const;

export const Kind = z.enum(KINDS);
export const Domain = z.enum(DOMAINS);
export const InstallMethod = z.enum(INSTALL_METHODS);

export type Kind = z.infer<typeof Kind>;
export type Domain = z.infer<typeof Domain>;
export type InstallMethod = z.infer<typeof InstallMethod>;

/** Domains list constraint: at least one, at most three (§6). */
export const Domains = z.array(Domain).min(1).max(3);

/**
 * Fallback for an unclassifiable repo. The LLM pass falls back here rather than
 * inventing a kind — see §4.2 pass 3.
 */
export const FALLBACK_KIND: Kind = 'service';

export const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);
export const isDomain = (value: string): value is Domain =>
  (DOMAINS as readonly string[]).includes(value);
export const isInstallMethod = (value: string): value is InstallMethod =>
  (INSTALL_METHODS as readonly string[]).includes(value);
