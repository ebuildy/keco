<?php

declare(strict_types=1);

namespace App\Discovery\Search;

/** One page of GitHub Search results, ported from `search.ts`'s `SearchPage` type. */
final readonly class SearchPage
{
    /**
     * @param list<SearchItem> $items
     * @param int              $dropped Items that failed {@see SearchItem} validation and were
     *                                  dropped — never silent, per AGENTS.md §13.
     */
    public function __construct(
        public int $totalCount,
        public bool $incompleteResults,
        public array $items,
        public int $dropped,
    ) {
    }
}
