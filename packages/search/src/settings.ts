import {
  MAX_TOTAL_HITS,
  TOOLS_FILTERABLE_ATTRIBUTES,
  TOOLS_INDEX,
  TOOLS_SEARCHABLE_ATTRIBUTES,
  TOOLS_SORTABLE_ATTRIBUTES,
} from '@keco/core';
import type { Settings } from 'meilisearch';

/**
 * The public search corpus. `tools` is an alias onto `tools_<ts>` (AGENTS.md §5).
 *
 * The name and the family→attribute mapping are defined in @keco/core, because the portal
 * needs both and §7 bars a browser bundle from importing this package.
 */
export const TOOLS_ALIAS = TOOLS_INDEX;

export const REPOS_STATE_INDEX = 'repos_state';
export const TRACES_INDEX = 'traces';

export const toolsIndexName = (timestamp = new Date()): string =>
  `tools_${timestamp.toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;

export const TOOLS_SETTINGS: Settings = {
  // Weight order matters: a name match must outrank a README mention.
  searchableAttributes: [...TOOLS_SEARCHABLE_ATTRIBUTES],
  filterableAttributes: [...TOOLS_FILTERABLE_ATTRIBUTES],
  sortableAttributes: [...TOOLS_SORTABLE_ATTRIBUTES],
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
  // The default 1000 caps deep paging; raised deliberately (§5). The same constant bounds
  // the API's `?page=` clamp, so the two cannot drift.
  pagination: { maxTotalHits: MAX_TOTAL_HITS },
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
