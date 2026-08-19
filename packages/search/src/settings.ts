import { TAXONOMY, TOOLS_INDEX, familyAttribute } from '@keco/core';
import type { Settings } from 'meilisearch';

/**
 * The public search corpus. `tools` is an alias onto `tools_<ts>` (AGENTS.md §5).
 *
 * The name and the family→attribute mapping are defined in @keco/core, because the portal
 * needs both and §7 bars a browser bundle from importing this package. Re-exported here so
 * every existing caller keeps its import.
 */
export const TOOLS_ALIAS = TOOLS_INDEX;
export { familyAttribute };

export const REPOS_STATE_INDEX = 'repos_state';
export const TRACES_INDEX = 'traces';

export const toolsIndexName = (timestamp = new Date()): string =>
  `tools_${timestamp.toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;

/**
 * Attributes Meilisearch filters on that are not taxonomy families: raw repository facts
 * and the numeric gates the query layer applies.
 */
const NON_TAXONOMY_FILTERABLE = [
  'language',
  'license',
  'archived',
  'stars',
  'has_release',
  'k8s_relevance',
  'has_scorecard',
  'owner',
];

export const TOOLS_SETTINGS: Settings = {
  // Weight order matters: a name match must outrank a README mention.
  searchableAttributes: [
    'name',
    'full_name',
    'summary',
    'description',
    'github_topics',
    'readme_excerpt',
  ],
  filterableAttributes: [
    ...TAXONOMY.map((family) => familyAttribute(family.id)),
    ...NON_TAXONOMY_FILTERABLE,
  ],
  sortableAttributes: ['stars', 'score.total', 'score.momentum', 'pushed_at'],
  // Default ranking rules, then health as the tie-breaker — relevance first, always.
  rankingRules: [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness',
    'score.total:desc',
  ],
  // The default 1000 caps deep paging; raised deliberately (§5).
  pagination: { maxTotalHits: 10_000 },
  faceting: { maxValuesPerFacet: 200 },
  displayedAttributes: ['*'],
  typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
};

/**
 * `searchableAttributes: []` makes an index a plain key-value store: no inverted index,
 * minimal RAM, still filterable and retrievable (§5). Used for everything that is not
 * the search corpus.
 */
export const REPOS_STATE_SETTINGS: Settings = {
  searchableAttributes: [],
  filterableAttributes: ['phase', 'repo', 'confidence', 'skip_reason'],
  sortableAttributes: ['fetched_at', 'analyzed_at', 'projected_at', 'confidence'],
};

export const TRACES_SETTINGS: Settings = {
  searchableAttributes: [],
  filterableAttributes: ['weak_retrieval', 'ts'],
  sortableAttributes: ['ts'],
};
