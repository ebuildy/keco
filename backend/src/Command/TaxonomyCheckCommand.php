<?php

declare(strict_types=1);

namespace App\Command;

use App\Taxonomy\TaxonomyLoader;
use App\Taxonomy\TaxonomyValidationException;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * `mise run taxonomy:check`'s PHP equivalent (AGENTS.md §6, §8): validates
 * `taxonomy/taxonomy.yaml` and fails loudly — non-zero exit, a clear message — on a malformed
 * file, exactly like the TS `check-taxonomy.ts` binary it mirrors.
 */
#[AsCommand(
    name: 'app:taxonomy:check',
    description: 'Validate taxonomy/taxonomy.yaml (schema, duplicates, "unknown" defaults).',
)]
final class TaxonomyCheckCommand extends Command
{
    public function __construct(
        private readonly TaxonomyLoader $taxonomyLoader,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addOption(
            'path',
            null,
            InputOption::VALUE_REQUIRED,
            'Validate this file instead of the real taxonomy/taxonomy.yaml — for CI dry runs against a candidate file.',
        );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $pathOption = $input->getOption('path');
        $path = \is_string($pathOption) ? $pathOption : null;
        $loader = null === $path ? $this->taxonomyLoader : new TaxonomyLoader($path);

        try {
            $file = $loader->load();
        } catch (TaxonomyValidationException $e) {
            $io->error($e->getMessage());

            return Command::FAILURE;
        }

        $totalValues = 0;
        $rows = [];
        foreach ($file->families as $family) {
            $hidden = 0;
            $aliases = 0;
            foreach ($family->values as $value) {
                if ($value->hidden) {
                    ++$hidden;
                }
                $aliases += \count($value->aliases);
            }
            $totalValues += \count($family->values);

            $rows[] = [
                $family->id,
                $family->cardinality,
                $family->source,
                \sprintf(
                    '%d values (%d hidden, %d aliases)',
                    \count($family->values),
                    $hidden,
                    $aliases,
                ),
            ];
        }

        $io->table(['family', 'cardinality', 'source', 'summary'], $rows);
        $io->success(\sprintf(
            'taxonomy ok — %d families, %d values',
            \count($file->families),
            $totalValues,
        ));

        return Command::SUCCESS;
    }
}
