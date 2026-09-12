<?php

declare(strict_types=1);

namespace App\Discovery\Console;

use App\Discovery\DiscoverySweepRunner;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * `kecoctl discovery sweep`'s PHP equivalent (AGENTS.md §8): enumerate every repo matching a
 * keyword into `DiscoveryRepo`, resuming from `DiscoveryState` by default.
 */
#[AsCommand(
    name: 'app:discovery:sweep',
    description: 'Enumerate every repo matching a keyword into DiscoveryRepo, via GitHub Search.',
)]
final class DiscoverySweepCommand extends Command
{
    public function __construct(
        private readonly DiscoverySweepRunner $runner,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('query', 'q', InputOption::VALUE_REQUIRED, 'Keyword to enumerate', 'kubernetes')
            ->addOption('limit', 'l', InputOption::VALUE_REQUIRED, 'Stop after roughly this many repos (overshoots)')
            ->addOption('fresh', null, InputOption::VALUE_NONE, "Start this keyword's sweep over instead of resuming")
            ->setHelp(
                "One namespace per keyword, so several keywords can share the tables. Resumes from\n".
                "this keyword's DiscoveryState row by default; --fresh deletes its corpus and state\n".
                "and starts over, leaving other keywords and the run history alone.\n\n".
                "--limit stops at the first window boundary past N, so it overshoots. It is a dev-run\n".
                "convenience, not a budget.\n\n".
                'Exits 1 if any window failed: a truncated corpus that exits 0 would let a scheduled '.
                'sweep hand the crawler a missing star band and call it a success.',
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $queryOption = $input->getOption('query');
        $query = \is_string($queryOption) ? $queryOption : 'kubernetes';

        $limitOption = $input->getOption('limit');
        $limit = \is_string($limitOption) && '' !== $limitOption ? (int) $limitOption : null;

        $fresh = true === $input->getOption('fresh');

        $io->text(\sprintf('discovery: sweeping "%s"%s%s', $query, $fresh ? ' (fresh)' : '', null !== $limit ? " (limit {$limit})" : ''));

        $result = $this->runner->run($query, $limit, $fresh);

        $io->table(['field', 'value'], [
            ['run_id', $result->runId],
            ['resuming', $result->resuming ? 'yes' : 'no'],
            ['repos', (string) $result->reposTotal],
            ['windows completed', (string) $result->windowsCompleted],
            ['windows failed', (string) $result->windowsFailed],
            ['windows pending', (string) $result->windowsPending],
            ['pages fetched', (string) $result->pagesFetched],
            ['dropped items', (string) $result->droppedItems],
            ['stopped at limit', $result->stoppedAtLimit ? 'yes' : 'no'],
        ]);

        if (!$result->success) {
            $io->error(\sprintf('discovery finished with %d failed window(s) — the corpus is incomplete', $result->windowsFailed));

            return Command::FAILURE;
        }

        $io->success('discovery complete');

        return Command::SUCCESS;
    }
}
