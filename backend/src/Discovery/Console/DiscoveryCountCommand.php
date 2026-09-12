<?php

declare(strict_types=1);

namespace App\Discovery\Console;

use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/** `app:discovery:count` — how much discovery data exists, per query. */
#[AsCommand(
    name: 'app:discovery:count',
    description: 'How much discovery data exists, per query.',
)]
final class DiscoveryCountCommand extends Command
{
    public function __construct(
        private readonly DiscoveryExplorer $explorer,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('query', null, InputOption::VALUE_REQUIRED, 'Narrow to one query')
            ->addOption('json', null, InputOption::VALUE_NONE, 'Emit NDJSON to stdout instead of a table')
            ->setHelp(
                "Every table at once — a partial answer is not what anyone opens this for.\n".
                'PENDING WINDOWS is what says whether a sweep finished or is mid-resume.',
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $queryOption = $input->getOption('query');
        $query = \is_string($queryOption) ? $queryOption : null;

        $rows = $this->explorer->count($query);

        if ($input->getOption('json')) {
            foreach ($rows as $row) {
                $output->writeln(json_encode([
                    'query' => $row->query,
                    'query_slug' => $row->querySlug,
                    'repos' => $row->repos,
                    'runs' => $row->runs,
                    'pending_windows' => $row->pendingWindows,
                    'last_run_outcome' => $row->lastRun?->getOutcome(),
                ], \JSON_THROW_ON_ERROR));
            }

            return Command::SUCCESS;
        }

        if ([] === $rows) {
            $io->text('no discovery data — run `app:discovery:sweep --query <keyword>` first');

            return Command::SUCCESS;
        }

        $io->table(
            ['query', 'repos', 'runs', 'pending windows', 'last sweep outcome'],
            array_map(static fn ($row): array => [
                $row->query,
                (string) $row->repos,
                (string) $row->runs,
                (string) $row->pendingWindows,
                $row->lastRun?->getOutcome() ?? '—',
            ], $rows),
        );

        return Command::SUCCESS;
    }
}
