import { MAX_TOTAL_HITS, type ToolDocument } from '@keco/core';

/**
 * Mock query engine — development and test only.
 *
 * An evaluator for the finite grammar `buildFilters()` and `sortSpec()` can emit, not a
 * general Meilisearch implementation. It approximates relevance and must never be used to
 * judge ranking, tune searchableAttributes weights, or validate a filter before production.
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
 */
export function valuesAt(tool: ToolDocument, path: string): unknown[] {
  let current: unknown[] = [tool];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item !== null && typeof item === 'object') {
            next.push((item as Record<string, unknown>)[segment]);
          }
        }
        continue;
      }
      if (typeof node === 'object') next.push((node as Record<string, unknown>)[segment]);
    }
    current = next.flatMap((value) => (Array.isArray(value) ? value : [value]));
  }
  return current.filter((value) => value !== undefined);
}

const IN_CLAUSE = /^(?<attribute>[\w.]+)\s+IN\s+\[(?<values>.*)\]$/;
const COMPARISON = /^(?<attribute>[\w.]+)\s*(?<operator>>=|<=|=|>|<)\s*(?<literal>.+)$/;

const parseLiteral = (raw: string): string | number | boolean => {
  const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const asNumber = Number(trimmed);
  return trimmed !== '' && !Number.isNaN(asNumber) ? asNumber : trimmed;
};

function matchesClause(tool: ToolDocument, clause: string): boolean {
  const inMatch = IN_CLAUSE.exec(clause.trim());
  if (inMatch?.groups) {
    const wanted = (inMatch.groups.values ?? '')
      .split(',')
      .map((value) => String(parseLiteral(value)))
      .filter((value) => value !== '');
    const actual = valuesAt(tool, inMatch.groups.attribute ?? '').map(String);
    return actual.some((value) => wanted.includes(value));
  }

  const comparison = COMPARISON.exec(clause.trim());
  if (comparison?.groups) {
    const expected = parseLiteral(comparison.groups.literal ?? '');
    const actual = valuesAt(tool, comparison.groups.attribute ?? '');
    return actual.some((value) => {
      switch (comparison.groups?.operator) {
        case '=': return value === expected;
        case '>=': return Number(value) >= Number(expected);
        case '<=': return Number(value) <= Number(expected);
        case '>': return Number(value) > Number(expected);
        case '<': return Number(value) < Number(expected);
        default: return false;
      }
    });
  }

  // An unrecognised clause means the portal emits something this engine does not model.
  // Failing loudly is the whole point — a silently ignored filter shows wrong results.
  throw new Error(`mock engine: unsupported filter clause ${JSON.stringify(clause)}`);
}

/** Every clause must hold: buildFilters() returns an array, and Meilisearch ANDs it. */
const matchesFilters = (tool: ToolDocument, filters: string[]): boolean =>
  filters.every((clause) => matchesClause(tool, clause));

/**
 * `tools`' searchableAttributes in weight order (§5). A lower index is a better match. This
 * approximates Meilisearch's relevance; it does not reproduce it.
 */
const SEARCHABLE = ['name', 'full_name', 'summary', 'description', 'github_topics', 'readme_excerpt'] as const;

/** Best (lowest) field index the query matches, or null when nothing matches. */
function matchRank(tool: ToolDocument, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return SEARCHABLE.length;

  for (const [index, attribute] of SEARCHABLE.entries()) {
    const haystack = valuesAt(tool, attribute)
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (haystack.includes(needle)) return index;
  }
  return null;
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

// Task 8 replaces this stub with the real facet distribution implementation.
const facetDistribution = (_tools: ToolDocument[], _facets: string[]): Record<string, Record<string, number>> => ({});

export function runSearch(corpus: ToolDocument[], request: MockSearchRequest): MockSearchResponse {
  const query = request.q ?? '';

  const ranked: { tool: ToolDocument; rank: number }[] = [];
  for (const tool of corpus) {
    if (!matchesFilters(tool, request.filter ?? [])) continue;
    const rank = matchRank(tool, query);
    if (rank === null) continue;
    ranked.push({ tool, rank });
  }

  const sorts = request.sort ?? [];
  if (sorts.length > 0) {
    for (const spec of [...sorts].reverse()) ranked.sort((a, b) => compareBy(spec)(a.tool, b.tool));
  } else {
    // No sort: match quality first, then score.total — the index's tie-breaker (§5).
    ranked.sort((a, b) => a.rank - b.rank || b.tool.score.total - a.tool.score.total);
  }

  const matched = ranked.map((entry) => entry.tool);
  const hitsPerPage = request.hitsPerPage ?? 20;
  const page = request.page ?? 1;
  const totalHits = Math.min(matched.length, MAX_TOTAL_HITS);

  return {
    hits: hitsPerPage === 0 ? [] : matched.slice((page - 1) * hitsPerPage, page * hitsPerPage),
    query,
    page,
    hitsPerPage,
    totalHits,
    totalPages: hitsPerPage === 0 ? 0 : Math.ceil(totalHits / hitsPerPage),
    processingTimeMs: 1,
    facetDistribution: facetDistribution(matched, request.facets ?? []),
  };
}
