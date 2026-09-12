<?php

declare(strict_types=1);

namespace App\Taxonomy;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\Yaml\Exception\ParseException;
use Symfony\Component\Yaml\Yaml;

/**
 * Loads and fully validates `taxonomy/taxonomy.yaml` (AGENTS.md §6): the closed vocabulary
 * declared in data, shared unchanged by backend/ (PHP) and apps/web (JS). This is a PHP port of
 * packages/core/src/taxonomy-schema.ts's `parseTaxonomy()` — same shape checks, same
 * cross-family invariants, same failure messages where the TS side names one, so a malformed
 * file fails the same way from either language.
 */
final class TaxonomyLoader
{
    public function __construct(
        #[Autowire('%app.taxonomy_path%')]
        private readonly string $path,
    ) {
    }

    /**
     * @throws TaxonomyValidationException on any problem — missing file, invalid YAML, a shape
     *                                      that doesn't match, or a violated cross-family rule
     */
    public function load(): TaxonomyFile
    {
        if (!is_file($this->path)) {
            throw TaxonomyValidationException::because("{$this->path} not found.");
        }

        try {
            $parsed = Yaml::parseFile($this->path);
        } catch (ParseException $e) {
            throw TaxonomyValidationException::because("invalid YAML: {$e->getMessage()}");
        }

        return $this->parse($this->asMapping($parsed, 'the file'));
    }

    /**
     * @param array<string, mixed> $parsed
     */
    private function parse(array $parsed): TaxonomyFile
    {
        $version = $parsed['version'] ?? null;
        if (1 !== $version) {
            throw TaxonomyValidationException::because('version must be 1.');
        }

        $rawFamilies = $parsed['families'] ?? null;
        if (!\is_array($rawFamilies) || [] === $rawFamilies) {
            throw TaxonomyValidationException::because('families must be a non-empty list.');
        }

        $familyIds = [];
        $params = [];
        $families = [];

        foreach ($rawFamilies as $rawFamily) {
            $family = $this->parseFamily($this->asMapping($rawFamily, 'each family'));

            if (isset($familyIds[$family->id])) {
                throw TaxonomyValidationException::because("duplicate family id: {$family->id}");
            }
            $familyIds[$family->id] = true;

            if (isset($params[$family->param])) {
                throw TaxonomyValidationException::because("duplicate family param: {$family->param}");
            }
            $params[$family->param] = true;

            if ('one' === $family->cardinality && (null !== $family->min || null !== $family->max)) {
                throw TaxonomyValidationException::because(
                    "family {$family->id} is cardinality: one and cannot declare min or max",
                );
            }
            if (null !== $family->min && null !== $family->max && $family->min > $family->max) {
                throw TaxonomyValidationException::because(
                    "family {$family->id} has min {$family->min} greater than max {$family->max}",
                );
            }

            $this->assertValuesAreConsistent($family);

            $families[] = $family;
        }

        return new TaxonomyFile($version, $families);
    }

    private function assertValuesAreConsistent(TaxonomyFamily $family): void
    {
        $valueIds = [];
        $aliases = [];
        $hasUnknown = false;

        foreach ($family->values as $value) {
            if (isset($valueIds[$value->id])) {
                throw TaxonomyValidationException::because("duplicate value id: {$family->id}/{$value->id}");
            }
            $valueIds[$value->id] = true;

            // A selectable "Unknown" chip on the portal home page is a UI defect, not a
            // feature — enforced here rather than trusted to every family author.
            if ('unknown' === $value->id) {
                $hasUnknown = true;
                if (!$value->hidden) {
                    throw TaxonomyValidationException::because(
                        "family {$family->id} has an \"unknown\" value that is not hidden",
                    );
                }
            }

            foreach ($value->aliases as $alias) {
                $key = strtolower($alias);
                // One alias must map to exactly one value, or classification becomes
                // order-dependent.
                if (isset($aliases[$key])) {
                    throw TaxonomyValidationException::because("duplicate alias: {$family->id}/{$key}");
                }
                $aliases[$key] = true;
            }
        }

        // Absence of evidence must never become a positive claim (§4.2).
        if ('derived' === $family->source && !$hasUnknown) {
            throw TaxonomyValidationException::because("derived family {$family->id} has no \"unknown\" value");
        }
    }

    /**
     * @param array<string, mixed> $raw
     */
    private function parseFamily(array $raw): TaxonomyFamily
    {
        $id = $this->requireString($raw, 'id', 'family');
        if (!preg_match('/^[a-z0-9]+(_[a-z0-9]+)*$/', $id)) {
            throw TaxonomyValidationException::because("family id \"{$id}\" must be lower_snake_case.");
        }

        $param = $this->requireString($raw, 'param', "family {$id}");
        if (!preg_match('/^[a-z0-9]+(_[a-z0-9]+)*$/', $param)) {
            throw TaxonomyValidationException::because("family {$id} param \"{$param}\" must be lower_snake_case.");
        }

        $cardinality = $this->requireString($raw, 'cardinality', "family {$id}");
        if (!\in_array($cardinality, ['one', 'many'], true)) {
            throw TaxonomyValidationException::because("family {$id} cardinality must be \"one\" or \"many\".");
        }

        $source = $this->requireString($raw, 'source', "family {$id}");
        if (!\in_array($source, ['analyzer', 'derived', 'registry'], true)) {
            throw TaxonomyValidationException::because(
                "family {$id} source must be \"analyzer\", \"derived\" or \"registry\".",
            );
        }

        $rawValues = $raw['values'] ?? null;
        if (!\is_array($rawValues) || [] === $rawValues) {
            throw TaxonomyValidationException::because("family {$id} values must be a non-empty list.");
        }

        $values = array_values(array_map(
            fn (mixed $rawValue): TaxonomyValue => $this->parseValue($this->asMapping($rawValue, "a value of family {$id}"), $id),
            $rawValues,
        ));

        return new TaxonomyFamily(
            id: $id,
            label: $this->requireString($raw, 'label', "family {$id}"),
            param: $param,
            description: $this->requireString($raw, 'description', "family {$id}"),
            cardinality: $cardinality,
            source: $source,
            values: $values,
            min: $this->optionalInt($raw, 'min'),
            max: $this->optionalInt($raw, 'max'),
            facet: $this->optionalBool($raw, 'facet', true),
        );
    }

    /**
     * @param array<string, mixed> $raw
     */
    private function parseValue(array $raw, string $familyId): TaxonomyValue
    {
        $id = $this->requireString($raw, 'id', "a value of family {$familyId}");
        if (!preg_match('/^[a-z0-9]+(-[a-z0-9]+)*$/', $id)) {
            throw TaxonomyValidationException::because(
                "value id \"{$id}\" in family {$familyId} must be lower-kebab-case.",
            );
        }

        $rawAliases = $raw['aliases'] ?? [];
        if (!\is_array($rawAliases)) {
            throw TaxonomyValidationException::because("aliases of {$familyId}/{$id} must be a list.");
        }

        $aliases = [];
        foreach ($rawAliases as $rawAlias) {
            if (!\is_string($rawAlias)) {
                throw TaxonomyValidationException::because("aliases of {$familyId}/{$id} must be strings.");
            }
            $aliases[] = $rawAlias;
        }

        return new TaxonomyValue(
            id: $id,
            label: $this->requireString($raw, 'label', "{$familyId}/{$id}"),
            description: $this->requireString($raw, 'description', "{$familyId}/{$id}"),
            aliases: $aliases,
            hidden: $this->optionalBool($raw, 'hidden', false),
        );
    }

    /**
     * Validates that `$value` is a YAML mapping (an array with string keys) and narrows its type
     * accordingly, so every caller downstream can declare `array<string, mixed>` truthfully
     * instead of the `array<mixed, mixed>` a bare `is_array()` check leaves PHPStan with.
     *
     * @return array<string, mixed>
     */
    private function asMapping(mixed $value, string $context): array
    {
        if (!\is_array($value)) {
            throw TaxonomyValidationException::because("{$context} must be a mapping.");
        }

        foreach (array_keys($value) as $key) {
            if (!\is_string($key)) {
                throw TaxonomyValidationException::because("{$context} must be a mapping with string keys.");
            }
        }

        /** @var array<string, mixed> $value */
        return $value;
    }

    /**
     * @param array<string, mixed> $raw
     */
    private function requireString(array $raw, string $key, string $context): string
    {
        $value = $raw[$key] ?? null;
        if (!\is_string($value) || '' === $value) {
            throw TaxonomyValidationException::because("{$context} is missing a non-empty \"{$key}\".");
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $raw
     */
    private function optionalInt(array $raw, string $key): ?int
    {
        $value = $raw[$key] ?? null;
        if (null === $value) {
            return null;
        }
        if (!\is_int($value)) {
            throw TaxonomyValidationException::because("\"{$key}\" must be an integer.");
        }

        return $value;
    }

    /**
     * @param array<string, mixed> $raw
     */
    private function optionalBool(array $raw, string $key, bool $default): bool
    {
        $value = $raw[$key] ?? null;
        if (null === $value) {
            return $default;
        }
        if (!\is_bool($value)) {
            throw TaxonomyValidationException::because("\"{$key}\" must be a boolean.");
        }

        return $value;
    }
}
