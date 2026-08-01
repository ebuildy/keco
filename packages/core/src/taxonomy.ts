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
 *
 * Import cost: this module reads the file, parses YAML and runs full zod validation
 * synchronously at import time. `index.ts` re-exports it and `schemas.ts` imports value
 * bindings from it, so importing *anything* from `@keco/core` now pays that cost — including
 * consumers that only wanted, say, `CONSUMERS` from the events module. The cost is
 * sub-millisecond and not worth rewiring existing imports over, but if you're writing a new
 * consumer that has no need for the taxonomy, prefer the `@keco/core/events` or
 * `@keco/core/schemas` subpath exports to skip it.
 */
const FILENAME = 'taxonomy.yaml';

/**
 * Resolves `packages/core/taxonomy.yaml` relative to this module's own compiled location.
 *
 * Verified: plain Node ESM (workers) and vitest, both of which preserve `import.meta.url`
 * pointing at the real file on disk. Not verified: a bundler that rewrites or inlines
 * `import.meta.url` (e.g. a Next production bundle) would break this — that path is the
 * portal build task's job to prove, not guessed at here. No env-var override and no
 * fallback search are added speculatively; if the Next build needs one, add it with
 * evidence from that failure, not in advance of it.
 */
export function taxonomyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', FILENAME);
}

/**
 * Reads the taxonomy file at `path` (default: `taxonomyPath()`). The `path` parameter exists
 * so the not-found branch is reachable from a test without a filesystem mocking layer — by
 * the time any other test runs, module load has already succeeded once, so that branch would
 * otherwise be untestable.
 */
export function readTaxonomyFile(path: string = taxonomyPath()): string {
  if (!existsSync(path)) {
    throw new Error(`taxonomy: ${FILENAME} not found. Looked in:\n  ${path}`);
  }
  return readFileSync(path, 'utf8');
}

const FILE = parseTaxonomy(readTaxonomyFile());

/**
 * Every family, in declared order. Plain data — safe to pass to a client component.
 *
 * This array (and the arrays returned by `family()` / `allValues()`) is the module's shared
 * singleton state, not a copy. Callers must treat it as read-only: `TAXONOMY[0].values.sort()`
 * mutates the taxonomy for the rest of the process, silently, for every later caller. This is
 * a convention, not something enforced at runtime.
 */
export const TAXONOMY: TaxonomyFamily[] = FILE.families;

const BY_ID = new Map(TAXONOMY.map((f) => [f.id, f]));
const BY_PARAM = new Map(TAXONOMY.map((f) => [f.param, f]));

/**
 * Throws on an unknown id. Callers pass a family id they already believe is valid — a
 * literal in code, a key from another part of the taxonomy — so a typo should fail fast and
 * loud rather than propagate a `null` through several layers before something else breaks.
 */
export function family(id: string): TaxonomyFamily {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`taxonomy: unknown family: ${id}`);
  return found;
}

/**
 * Returns `null` on an unknown param, rather than throwing. Callers pass untrusted input —
 * a URL query parameter — where "not a known family" is an expected, ordinary outcome to be
 * handled (e.g. ignore the filter), not a bug to crash on.
 */
export const familyByParam = (param: string): TaxonomyFamily | null => BY_PARAM.get(param) ?? null;
export const paramFor = (familyId: string): string => family(familyId).param;

/** Visible values — what the UI renders. A fresh copy; safe to sort or mutate. */
export const values = (familyId: string): TaxonomyValue[] =>
  family(familyId).values.filter((value) => !value.hidden);

/**
 * Every value including hidden ones — what validation accepts. Returns a shallow copy, not
 * the family's internal array: `allValues('kind').sort(...)` must not reorder `TAXONOMY`
 * itself for every later caller in the process.
 */
export const allValues = (familyId: string): TaxonomyValue[] => [...family(familyId).values];

export const isValue = (familyId: string, id: string): boolean =>
  family(familyId).values.some((value) => value.id === id);

/**
 * Lowercased external identifier → value id. Look up with `.toLowerCase()`.
 *
 * Intentionally uncached: it rebuilds the map on every call. The taxonomy is static for the
 * process lifetime and the map is small (tens of entries), so the correct move is to hoist
 * the result out of a hot loop at the call site, not to memoize it in here defensively.
 */
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
