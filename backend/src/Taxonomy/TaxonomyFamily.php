<?php

declare(strict_types=1);

namespace App\Taxonomy;

/**
 * One family of the taxonomy (AGENTS.md §6). Mirrors
 * packages/core/src/taxonomy-schema.ts's TaxonomyFamilySchema field for field.
 */
final class TaxonomyFamily
{
    /**
     * @param 'one'|'many'                 $cardinality
     * @param 'analyzer'|'derived'|'registry' $source
     * @param list<TaxonomyValue>          $values
     */
    public function __construct(
        public readonly string $id,
        public readonly string $label,
        public readonly string $param,
        public readonly string $description,
        public readonly string $cardinality,
        public readonly string $source,
        public readonly array $values,
        public readonly ?int $min = null,
        public readonly ?int $max = null,
        public readonly bool $facet = true,
    ) {
    }
}
