import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * The shape of `packages/core/taxonomy.yaml` (AGENTS.md §6). This module is pure: it takes
 * text, never a path, so the loader can decide where the file lives and the tests can drive
 * broken files through it without touching disk.
 *
 * Zod covers the shape. The cross-family invariants below cannot be expressed in the shape
 * and are checked afterwards, each with a message naming the offending id — a taxonomy that
 * fails to load takes every worker and the web app down, so the message must be enough to
 * fix the file without a debugger.
 */
export const TaxonomyValueSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'value ids are lower-kebab-case'),
  label: z.string().min(1),
  description: z.string().min(1),
  /** External identifiers that map to this value: GitHub topics, SPDX ids. Lowercased on read. */
  aliases: z.array(z.string()).default([]),
  /** Never rendered as a chip. `unknown` is always hidden — `parseTaxonomy` enforces it. */
  hidden: z.boolean().default(false),
});
export type TaxonomyValue = z.infer<typeof TaxonomyValueSchema>;

export const TaxonomyFamilySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'family ids are lower_snake_case'),
  label: z.string().min(1),
  /** The URL query parameter. Differs from `id` where a plural reads badly (domains → domain). */
  param: z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'params are lower_snake_case'),
  description: z.string().min(1),
  cardinality: z.enum(['one', 'many']),
  /** `cardinality: many` only. Absent means unbounded. */
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(1).optional(),
  /** Who assigns it: analyzer rules, derivation from metadata, or a registry with proof. */
  source: z.enum(['analyzer', 'derived', 'registry']),
  /** Whether it renders as a home-page chip row. */
  facet: z.boolean().default(true),
  values: z.array(TaxonomyValueSchema).min(1),
});
export type TaxonomyFamily = z.infer<typeof TaxonomyFamilySchema>;

export const TaxonomyFileSchema = z.object({
  version: z.literal(1),
  families: z.array(TaxonomyFamilySchema).min(1),
});
export type TaxonomyFile = z.infer<typeof TaxonomyFileSchema>;

const fail = (message: string): never => {
  throw new Error(`taxonomy: ${message}`);
};

/**
 * Parses and fully validates the file. Throws with an actionable message on any problem.
 *
 * Every failure mode — YAML syntax, zod shape, cross-family invariant — throws a plain `Error`
 * whose message starts `taxonomy: ` and reads as prose. A taxonomy that fails to load takes
 * every worker and the web app down, so whoever hand-edits the file needs an answer they can
 * act on, not a stack trace through a parser they've never heard of.
 */
export function parseTaxonomy(text: string): TaxonomyFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    fail(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  let file: TaxonomyFile;
  try {
    file = TaxonomyFileSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      fail(z.prettifyError(error));
    }
    throw error;
  }

  const familyIds = new Set<string>();
  const params = new Set<string>();

  for (const family of file.families) {
    if (familyIds.has(family.id)) fail(`duplicate family id: ${family.id}`);
    familyIds.add(family.id);

    if (params.has(family.param)) fail(`duplicate family param: ${family.param}`);
    params.add(family.param);

    if (family.cardinality === 'one' && (family.min !== undefined || family.max !== undefined)) {
      fail(`family ${family.id} is cardinality: one and cannot declare min or max`);
    }
    if (family.min !== undefined && family.max !== undefined && family.min > family.max) {
      fail(`family ${family.id} has min ${family.min} greater than max ${family.max}`);
    }

    const valueIds = new Set<string>();
    const aliases = new Set<string>();
    for (const value of family.values) {
      if (valueIds.has(value.id)) fail(`duplicate value id: ${family.id}/${value.id}`);
      valueIds.add(value.id);

      // A selectable "Unknown" chip on the portal home page is a UI defect, not a feature —
      // enforce the doc comment on `hidden` here rather than trusting every family author to
      // remember it by hand.
      if (value.id === 'unknown' && !value.hidden) {
        fail(`family ${family.id} has an "unknown" value that is not hidden`);
      }

      for (const alias of value.aliases) {
        const key = alias.toLowerCase();
        // One alias must map to exactly one value, or classification becomes order-dependent.
        if (aliases.has(key)) fail(`duplicate alias: ${family.id}/${key}`);
        aliases.add(key);
      }
    }

    // Absence of evidence must never become a positive claim (§4.2).
    if (family.source === 'derived' && !valueIds.has('unknown')) {
      fail(`derived family ${family.id} has no "unknown" value`);
    }
  }

  return file;
}
