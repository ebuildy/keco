<?php

declare(strict_types=1);

namespace App\Taxonomy;

/**
 * One value of a taxonomy family (AGENTS.md §6). Mirrors
 * packages/core/src/taxonomy-schema.ts's TaxonomyValueSchema field for field.
 */
final class TaxonomyValue
{
    /**
     * @param list<string> $aliases external identifiers (GitHub topics, SPDX ids) that map to
     *                              this value, stored as authored — lowercasing happens at
     *                              lookup time, not here
     */
    public function __construct(
        public readonly string $id,
        public readonly string $label,
        public readonly string $description,
        public readonly array $aliases = [],
        public readonly bool $hidden = false,
    ) {
    }
}
