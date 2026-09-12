<?php

declare(strict_types=1);

namespace App\Taxonomy;

/**
 * The fully validated contents of `taxonomy/taxonomy.yaml` (AGENTS.md §6).
 */
final class TaxonomyFile
{
    /**
     * @param list<TaxonomyFamily> $families
     */
    public function __construct(
        public readonly int $version,
        public readonly array $families,
    ) {
    }
}
