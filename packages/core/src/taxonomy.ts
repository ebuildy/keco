import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseTaxonomy, type TaxonomyFamily, type TaxonomyValue } from './taxonomy-schema';

/**
 * The closed vocabulary (AGENTS.md §6), loaded from `packages/core/taxonomy.yaml`.
 *
 * Two axes, never one: `kind` is what the artifact *is*, `domains` is what it solves.
 * Cilium is a controller AND networking; a flat category list cannot say that.
 *
 * The file is read once at module load and validated in full. A malformed taxonomy takes
 * every worker and the web app down immediately rather than letting them classify into a
 * vocabulary that does not exist.
 *
 * Because the vocabulary is data, `Kind` and friends are `string`, not literal unions. The
 * safety net that replaces compile-time checking is packages/analyze/src/rules/pinning.test.ts,
 * which asserts every value any rule can emit exists in this file.
 */
const FILENAME = 'taxonomy.yaml';

/** Walks up from `from` looking for the pnpm workspace root. */
function workspaceRoot(from: string): string | null {
  let current = from;
  for (;;) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Two resolution strategies, because the file has to be found under three different
 * runtimes: plain Node ESM (workers, vitest), the Next dev server, and a traced production
 * build. The first candidate covers the first two; the second covers a bundler that
 * rewrote import.meta.url. next.config.ts adds the file to outputFileTracingIncludes so it
 * is present in a standalone build.
 */
function readTaxonomyFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = workspaceRoot(here) ?? workspaceRoot(process.cwd());
  const candidates = [
    resolve(here, '..', FILENAME),
    ...(root ? [resolve(root, 'packages', 'core', FILENAME)] : []),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error(`taxonomy: ${FILENAME} not found. Looked in:\n  ${candidates.join('\n  ')}`);
}

const FILE = parseTaxonomy(readTaxonomyFile());

/** Every family, in declared order. Plain data — safe to pass to a client component. */
export const TAXONOMY: TaxonomyFamily[] = FILE.families;

const BY_ID = new Map(TAXONOMY.map((f) => [f.id, f]));
const BY_PARAM = new Map(TAXONOMY.map((f) => [f.param, f]));

export function family(id: string): TaxonomyFamily {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`taxonomy: unknown family: ${id}`);
  return found;
}

export const familyByParam = (param: string): TaxonomyFamily | null => BY_PARAM.get(param) ?? null;
export const paramFor = (familyId: string): string => family(familyId).param;

/** Visible values — what the UI renders. */
export const values = (familyId: string): TaxonomyValue[] =>
  family(familyId).values.filter((value) => !value.hidden);

/** Every value including hidden ones — what validation accepts. */
export const allValues = (familyId: string): TaxonomyValue[] => family(familyId).values;

export const isValue = (familyId: string, id: string): boolean =>
  family(familyId).values.some((value) => value.id === id);

/** Lowercased external identifier → value id. Look up with `.toLowerCase()`. */
export function aliasesFor(familyId: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of family(familyId).values) {
    for (const alias of value.aliases) map.set(alias.toLowerCase(), value.id);
  }
  return map;
}

export const facetableFamilies = (): string[] =>
  TAXONOMY.filter((f) => f.facet).map((f) => f.id);

/** A single value of a family. Hidden values are valid data; they are only hidden from the UI. */
export const valueSchema = (familyId: string) =>
  z.string().refine((value) => isValue(familyId, value), {
    message: `expected one of the ${familyId} taxonomy values`,
  });

/** A list of values, honouring the family's declared min and max. */
export function listSchema(familyId: string) {
  const { min, max } = family(familyId);
  let schema = z.array(valueSchema(familyId));
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema;
}

// ── legacy surface, now derived from the file ────────────────────────────────

export const KINDS: string[] = allValues('kind').map((v) => v.id);
export const DOMAINS: string[] = allValues('domains').map((v) => v.id);
export const INSTALL_METHODS: string[] = allValues('install_methods').map((v) => v.id);

export const Kind = valueSchema('kind');
export const Domain = valueSchema('domains');
export const InstallMethod = valueSchema('install_methods');

export type Kind = string;
export type Domain = string;
export type InstallMethod = string;

/** Domains list constraint: min and max come from the file (§6). */
export const Domains = listSchema('domains');

/**
 * Fallback for an unclassifiable repo. The LLM pass falls back here rather than inventing
 * a kind — see §4.2 pass 3.
 */
export const FALLBACK_KIND: Kind = 'service';

export const isKind = (value: string): boolean => isValue('kind', value);
export const isDomain = (value: string): boolean => isValue('domains', value);
export const isInstallMethod = (value: string): boolean => isValue('install_methods', value);

export type { TaxonomyFamily, TaxonomyValue };
