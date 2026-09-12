<?php

declare(strict_types=1);

namespace App\Tests\Unit\Taxonomy;

use App\Taxonomy\TaxonomyLoader;
use App\Taxonomy\TaxonomyValidationException;
use PHPUnit\Framework\TestCase;

/**
 * Mirrors packages/core/src/taxonomy-schema.ts's parseTaxonomy test coverage (AGENTS.md §6): the
 * same file must be loadable and the same invariants must be enforced from the PHP side, since
 * `taxonomy/taxonomy.yaml` is now shared, unchanged, by both backend/ (PHP) and apps/web (JS).
 */
final class TaxonomyLoaderTest extends TestCase
{
    private const REAL_TAXONOMY_PATH = __DIR__.'/../../../../taxonomy/taxonomy.yaml';

    private string $tmpDir;

    protected function setUp(): void
    {
        $this->tmpDir = sys_get_temp_dir().'/keco-taxonomy-test-'.bin2hex(random_bytes(8));
        mkdir($this->tmpDir);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->tmpDir.'/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->tmpDir);
    }

    private function writeFixture(string $yaml): string
    {
        $path = $this->tmpDir.'/taxonomy.yaml';
        file_put_contents($path, $yaml);

        return $path;
    }

    public function testLoadsTheRealTaxonomyFileWithExactParityToTheTsLoader(): void
    {
        $loader = new TaxonomyLoader(self::REAL_TAXONOMY_PATH);

        $file = $loader->load();

        // `mise run taxonomy:check` (TS) reports "8 families, 83 values" for the same file —
        // the cross-language parity check named in ADR 0005 / the migration design spec §8.
        self::assertSame(1, $file->version);
        self::assertCount(8, $file->families);

        $totalValues = array_sum(array_map(
            static fn ($family) => count($family->values),
            $file->families,
        ));
        self::assertSame(83, $totalValues);

        $kind = self::findFamily($file, 'kind');
        self::assertSame('one', $kind->cardinality);
        self::assertSame('analyzer', $kind->source);
    }

    public function testMissingFileThrowsALoudError(): void
    {
        $loader = new TaxonomyLoader($this->tmpDir.'/does-not-exist.yaml');

        $this->expectException(TaxonomyValidationException::class);
        $this->expectExceptionMessageMatches('/not found/');

        $loader->load();
    }

    public function testInvalidYamlSyntaxThrows(): void
    {
        $path = $this->writeFixture("version: 1\nfamilies: [this is not valid yaml:::");

        $loader = new TaxonomyLoader($path);

        $this->expectException(TaxonomyValidationException::class);
        $this->expectExceptionMessageMatches('/invalid YAML/');

        $loader->load();
    }

    public function testDuplicateFamilyIdThrows(): void
    {
        $path = $this->writeFixture(self::minimalFileWith(<<<YAML
            families:
              - id: kind
                label: Kind
                param: kind
                description: d
                cardinality: one
                source: analyzer
                values:
                  - {id: cli, label: CLI, description: d}
              - id: kind
                label: Kind Again
                param: kind2
                description: d
                cardinality: one
                source: analyzer
                values:
                  - {id: cli, label: CLI, description: d}
            YAML));

        $loader = new TaxonomyLoader($path);

        $this->expectException(TaxonomyValidationException::class);
        $this->expectExceptionMessageMatches('/duplicate family id: kind/');

        $loader->load();
    }

    public function testUnknownValueNotHiddenThrows(): void
    {
        $path = $this->writeFixture(self::minimalFileWith(<<<YAML
            families:
              - id: governance
                label: Governance
                param: governance
                description: d
                cardinality: one
                source: derived
                values:
                  - {id: foundation, label: Foundation, description: d}
                  - {id: unknown, label: Unknown, description: d}
            YAML));

        $loader = new TaxonomyLoader($path);

        $this->expectException(TaxonomyValidationException::class);
        $this->expectExceptionMessageMatches('/"unknown" value that is not hidden/');

        $loader->load();
    }

    public function testDerivedFamilyMissingUnknownThrows(): void
    {
        $path = $this->writeFixture(self::minimalFileWith(<<<YAML
            families:
              - id: governance
                label: Governance
                param: governance
                description: d
                cardinality: one
                source: derived
                values:
                  - {id: foundation, label: Foundation, description: d}
            YAML));

        $loader = new TaxonomyLoader($path);

        $this->expectException(TaxonomyValidationException::class);
        $this->expectExceptionMessageMatches('/no "unknown" value/');

        $loader->load();
    }

    public function testDuplicateValueIdThrows(): void
    {
        $path = $this->writeFixture(self::minimalFileWith(<<<YAML
            families:
              - id: kind
                label: Kind
                param: kind
                description: d
                cardinality: one
                source: analyzer
                values:
                  - {id: cli, label: CLI, description: d}
                  - {id: cli, label: CLI Again, description: d}
            YAML));

        $loader = new TaxonomyLoader($path);

        $this->expectException(TaxonomyValidationException::class);
        $this->expectExceptionMessageMatches('/duplicate value id: kind\/cli/');

        $loader->load();
    }

    public function testValidFixtureRoundTrips(): void
    {
        $path = $this->writeFixture(self::minimalFileWith(<<<YAML
            families:
              - id: kind
                label: Kind
                param: kind
                description: d
                cardinality: one
                source: analyzer
                values:
                  - {id: cli, label: CLI, description: d}
                  - {id: operator, label: Operator, description: d, aliases: [OPERATOR-TOPIC]}
            YAML));

        $file = (new TaxonomyLoader($path))->load();

        self::assertCount(1, $file->families);
        $kind = $file->families[0];
        self::assertSame('kind', $kind->id);
        self::assertCount(2, $kind->values);
        // Aliases are stored as authored; lowercasing happens at lookup time (mirrors
        // packages/core/src/taxonomy.ts's aliasesFor(), not parse time).
        self::assertSame(['OPERATOR-TOPIC'], $kind->values[1]->aliases);
        self::assertFalse($kind->values[0]->hidden);
    }

    private static function minimalFileWith(string $familiesYaml): string
    {
        return "version: 1\n{$familiesYaml}";
    }

    private static function findFamily(\App\Taxonomy\TaxonomyFile $file, string $id): \App\Taxonomy\TaxonomyFamily
    {
        foreach ($file->families as $family) {
            if ($family->id === $id) {
                return $family;
            }
        }

        self::fail("family {$id} not found");
    }
}
