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

        if (!\is_array($parsed)) {
            throw TaxonomyValidationException::because('the file must contain a YAML mapping.');
        }

        return $this->parse($parsed);
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
            $family = $this->parseFamily($rawFamily);

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
     * @param mixed $raw
     */
    private function parseFamily($raw): TaxonomyFamily
    {
        if (!\is_array($raw)) {
            throw TaxonomyValidationException::because('each family must be a mapping.');
        }

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

        return new TaxonomyFamily(
            id: $id,
            label: $this->requireString($raw, 'label', "family {$id}"),
            param: $param,
            description: $this->requireString($raw, 'description', "family {$id}"),
            cardinality: $cardinality,
            source: $source,
            values: array_map(fn ($rawValue) => $this->parseValue($rawValue, $id), $rawValues),
            min: $this->optionalInt($raw, 'min'),
            max: $this->optionalInt($raw, 'max'),
            facet: (bool) ($raw['facet'] ?? true),
        );
    }

    /**
     * @param mixed $raw
     */
    private function parseValue($raw, string $familyId): TaxonomyValue
    {
        if (!\is_array($raw)) {
            throw TaxonomyValidationException::because("each value of family {$familyId} must be a mapping.");
        }

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

        return new TaxonomyValue(
            id: $id,
            label: $this->requireString($raw, 'label', "{$familyId}/{$id}"),
            description: $this->requireString($raw, 'description', "{$familyId}/{$id}"),
            aliases: array_values(array_map('strval', $rawAliases)),
            hidden: (bool) ($raw['hidden'] ?? false),
        );
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
}
