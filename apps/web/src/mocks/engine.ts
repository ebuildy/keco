import {
  MAX_TOTAL_HITS,
  TOOLS_FILTERABLE_ATTRIBUTES,
  TOOLS_SEARCHABLE_ATTRIBUTES,
  TOOLS_SORTABLE_ATTRIBUTES,
  type ToolDocument,
} from '@keco/core';

/**
 * Mock query engine — development and test only.
 *
 * An evaluator for the finite grammar `buildFilters()` and `sortSpec()` can emit, not a
 * general Meilisearch implementation.
 *
 * Filters, facets, pagination and which documents match at all are NOT approximations —
 * those are the things a developer builds UI against and would carry into production, so
 * they must agree with real Meilisearch exactly. Every filter, sort and facet attribute is
 * checked against the real index settings (`TOOLS_FILTERABLE_ATTRIBUTES`,
 * `TOOLS_SORTABLE_ATTRIBUTES`) and throws on anything production would 400 on, rather than
 * silently answering it.
 *
 * What genuinely IS approximated — never rely on this engine to judge ranking, tune
 * searchableAttributes weights, or validate a filter before production:
 *
 * - Relevance ordering *within* a matched set: match rank here is the lowest-weighted
 *   searchable field any query token appears in. Real Meilisearch's `words` and `attribute`
 *   ranking rules also weigh how many terms matched and per-attribute weighting more finely
 *   than a single field-index rank.
 * - `proximity`: term-distance-within-a-field is not modelled at all.
 * - Typo tolerance: not implemented — a misspelled query matches nothing here, where
 *   Meilisearch's `typo` ranking rule would still surface the document.
 * - Matching is plain substring (infix) per token, not Meilisearch's actual word-boundary /
 *   prefix tokenisation — a token can match mid-word here in a way production would not.
 * - `facetDistribution` (below) is computed over the `MAX_TOTAL_HITS`-clamped matched set,
 *   whereas Meilisearch computes it over the whole filtered set before any pagination or hit
 *   cap. Unreachable at the corpus's current ~300 documents (nothing here approaches
 *   `MAX_TOTAL_HITS`), so left as is rather than fixed — noted here so it isn't a surprise if
 *   the corpus ever grows past the clamp.
 */

export type MockSearchRequest = {
  q?: string;
  filter?: string[];
  sort?: string[];
  page?: number;
  hitsPerPage?: number;
  facets?: string[];
};

export type MockSearchResponse = {
  hits: ToolDocument[];
  query: string;
  page: number;
  hitsPerPage: number;
  totalHits: number;
  totalPages: number;
  processingTimeMs: number;
  facetDistribution: Record<string, Record<string, number>>;
};

/**
 * Resolves a dotted attribute path to the values it can match. Returns an array because
 * `domains` is a list and `install_methods.method` is a projection over a list of objects —
 * a document matches if any resolved value matches.
 *
 * `Object.hasOwn` guards each object lookup so a typo'd or absent attribute (e.g.
 * `valuesAt(tool, 'constructor')`) returns nothing instead of walking the prototype chain.
 * `null` is dropped alongside `undefined` in the final result — Meilisearch's own
 * facetDistribution never produces a `"null"` bucket for an absent value.
 */
export function valuesAt(tool: ToolDocument, path: string): unknown[] {
  let current: unknown[] = [tool];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item !== null && typeof item === 'object' && Object.hasOwn(item, segment)) {
            next.push((item as Record<string, unknown>)[segment]);
          }
        }
        continue;
      }
      if (typeof node === 'object' && Object.hasOwn(node, segment)) {
        next.push((node as Record<string, unknown>)[segment]);
      }
    }
    current = next.flatMap((value) => (Array.isArray(value) ? value : [value]));
  }
  return current.filter((value) => value !== undefined && value !== null);
}

function assertFilterable(attribute: string): void {
  if (!TOOLS_FILTERABLE_ATTRIBUTES.includes(attribute)) {
    throw new Error(
      `mock engine: "${attribute}" is not a filterable/facetable attribute of tools — production would reject this with invalid_search_filter/invalid_search_facets`,
    );
  }
}

function assertSortable(attribute: string): void {
  if (!(TOOLS_SORTABLE_ATTRIBUTES as readonly string[]).includes(attribute)) {
    throw new Error(
      `mock engine: "${attribute}" is not a sortable attribute of tools — production would reject this with invalid_search_sort`,
    );
  }
}

const IN_CLAUSE = /^(?<attribute>[\w.]+)\s+IN\s+\[(?<values>.*)\]$/;
const COMPARISON = /^(?<attribute>[\w.]+)\s*(?<operator>>=|<=|=|>|<)\s*(?<literal>.+)$/;

/**
 * A quoted literal (`"1.0"`) is always a string — never run through `Number()`, or `"1.0"`
 * and `"1"` become indistinguishable and `" "`/`"0x10"`/`"007"` silently coerce. Only an
 * unquoted literal (`false`, `0.4`) is a candidate for boolean/number parsing.
 */
const parseLiteral = (raw: string): string | number | boolean => {
  const trimmed = raw.trim();
  const quoted = /^"(.*)"$/.exec(trimmed);
  if (quoted) return quoted[1] ?? '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const asNumber = Number(trimmed);
  return trimmed !== '' && !Number.isNaN(asNumber) ? asNumber : trimmed;
};

type ParsedClause =
  | { kind: 'in'; attribute: string; wanted: string[] }
  | { kind: 'comparison'; attribute: string; operator: string; expected: string | number | boolean };

/**
 * Parses and validates one filter clause once per request (not once per document): both the
 * clause shape and the attribute name are checked up front, so an invalid request throws even
 * against an empty corpus.
 */
function parseClause(clause: string): ParsedClause {
  const inMatch = IN_CLAUSE.exec(clause.trim());
  if (inMatch?.groups) {
    const attribute = inMatch.groups.attribute ?? '';
    assertFilterable(attribute);
    const wanted = (inMatch.groups.values ?? '')
      .split(',')
      .map((value) => String(parseLiteral(value)))
      .filter((value) => value !== '');
    return { kind: 'in', attribute, wanted };
  }

  const comparison = COMPARISON.exec(clause.trim());
  if (comparison?.groups) {
    const attribute = comparison.groups.attribute ?? '';
    assertFilterable(attribute);
    return {
      kind: 'comparison',
      attribute,
      operator: comparison.groups.operator ?? '',
      expected: parseLiteral(comparison.groups.literal ?? ''),
    };
  }

  // An unrecognised clause means the portal emits something this engine does not model.
  // Failing loudly is the whole point — a silently ignored filter shows wrong results.
  throw new Error(`mock engine: unsupported filter clause ${JSON.stringify(clause)}`);
}

function matchesParsedClause(tool: ToolDocument, clause: ParsedClause): boolean {
  const actual = valuesAt(tool, clause.attribute);
  if (clause.kind === 'in') {
    const actualStrings = actual.map(String);
    return actualStrings.some((value) => clause.wanted.includes(value));
  }
  return actual.some((value) => {
    switch (clause.operator) {
      case '=': return value === clause.expected;
      case '>=': return Number(value) >= Number(clause.expected);
      case '<=': return Number(value) <= Number(clause.expected);
      case '>': return Number(value) > Number(clause.expected);
      case '<': return Number(value) < Number(clause.expected);
      default: return false;
    }
  });
}

/** Every clause must hold: buildFilters() returns an array, and Meilisearch ANDs it. */
const matchesFilters = (tool: ToolDocument, clauses: ParsedClause[]): boolean =>
  clauses.every((clause) => matchesParsedClause(tool, clause));

/**
 * `tools`' searchableAttributes, in weight order (§5) — shared with `packages/search` via
 * `@keco/core` so the two cannot drift.
 */
const SEARCHABLE = TOOLS_SEARCHABLE_ATTRIBUTES;

/**
 * Best (lowest) searchable-field index the query matches, or null when at least one query
 * token matches nowhere. Meilisearch's `words` ranking rule requires every term to be found
 * (in any order, across fields) for a document to match at all — a single substring match of
 * the whole query string is not how multi-word search works in production.
 */
function matchRank(tool: ToolDocument, query: string): number | null {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return SEARCHABLE.length;
  const tokens = trimmed.split(/\s+/).filter((token) => token !== '');

  const fieldsText = SEARCHABLE.map((attribute) =>
    valuesAt(tool, attribute)
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase(),
  );

  const everyTokenMatches = tokens.every((token) => fieldsText.some((text) => text.includes(token)));
  if (!everyTokenMatches) return null;

  for (const [index, text] of fieldsText.entries()) {
    if (tokens.some((token) => text.includes(token))) return index;
  }
  return null; // unreachable given everyTokenMatches, but keeps the return type honest
}

const compareBy = (spec: string) => (a: ToolDocument, b: ToolDocument): number => {
  const [attribute = '', direction = 'asc'] = spec.split(':');
  const [left] = valuesAt(a, attribute);
  const [right] = valuesAt(b, attribute);
  const order =
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left ?? '').localeCompare(String(right ?? ''));
  return direction === 'desc' ? -order : order;
};

/**
 * Counts documents per value for each requested attribute, over the filtered/matched set —
 * matching Meilisearch's facetDistribution semantics (§5): a value nothing matched is simply
 * absent from the map, never present with a zero count. (It is `chipRows` in
 * `apps/web/src/lib/topics.ts`, not this function, that turns "absent" into "no chip
 * rendered" — it defaults a missing value to 0 and filters `count > 0` itself.)
 */
function facetDistribution(
  tools: ToolDocument[],
  facets: string[],
): Record<string, Record<string, number>> {
  const distribution: Record<string, Record<string, number>> = {};

  for (const attribute of facets) {
    const counts: Record<string, number> = {};
    for (const tool of tools) {
      // A Set so a document with the same value twice still counts once.
      for (const value of new Set(valuesAt(tool, attribute).map(String))) {
        counts[value] = (counts[value] ?? 0) + 1;
      }
    }
    distribution[attribute] = counts;
  }

  return distribution;
}

export function runSearch(corpus: ToolDocument[], request: MockSearchRequest): MockSearchResponse {
  const query = request.q ?? '';
  const sorts = request.sort ?? [];
  const facets = request.facets ?? [];
  const hitsPerPage = request.hitsPerPage ?? 20;
  const page = request.page ?? 1;

  if (page < 1) {
    throw new Error(`mock engine: page must be >= 1, got ${page} — production rejects this with invalid_search_page`);
  }

  // Parse and validate once per request — attribute names are checked here, not per document,
  // so an invalid request throws even against an empty corpus.
  const parsedFilters = (request.filter ?? []).map(parseClause);
  for (const spec of sorts) assertSortable((spec.split(':')[0] ?? ''));
  for (const facet of facets) assertFilterable(facet);

  const ranked: { tool: ToolDocument; rank: number }[] = [];
  for (const tool of corpus) {
    if (!matchesFilters(tool, parsedFilters)) continue;
    const rank = matchRank(tool, query);
    if (rank === null) continue;
    ranked.push({ tool, rank });
  }

  if (sorts.length > 0) {
    // Rank stays primary: real Meilisearch applies `sort` as its fifth ranking rule, after
    // words/typo/proximity/attribute, so an explicit sort orders *within* relevance buckets
    // rather than overriding them. With an empty query every rank is equal (SEARCHABLE.length
    // for every document), so whatsHot()/findAlternatives() still get a pure sort.
    for (const spec of [...sorts].reverse()) {
      const compare = compareBy(spec);
      ranked.sort((a, b) => a.rank - b.rank || compare(a.tool, b.tool));
    }
  } else {
    // No sort: match quality first, then score.total — the index's tie-breaker (§5).
    ranked.sort((a, b) => a.rank - b.rank || b.tool.score.total - a.tool.score.total);
  }

  const matched = ranked.map((entry) => entry.tool).slice(0, MAX_TOTAL_HITS);
  const totalHits = matched.length;

  return {
    hits: hitsPerPage === 0 ? [] : matched.slice((page - 1) * hitsPerPage, page * hitsPerPage),
    query,
    page,
    hitsPerPage,
    totalHits,
    totalPages: hitsPerPage === 0 ? 0 : Math.ceil(totalHits / hitsPerPage),
    processingTimeMs: 1,
    facetDistribution: facetDistribution(matched, facets),
  };
}
