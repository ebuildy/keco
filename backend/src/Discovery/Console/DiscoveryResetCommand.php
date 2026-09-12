<?php

declare(strict_types=1);

namespace App\Discovery\Console;

use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * `app:discovery:reset` — deletes a query's corpus and resume state, keeping its run history.
 * Not rebuildable offline: the next sweep re-queries GitHub Search.
 */
#[AsCommand(
    name: 'app:discovery:reset',
    description: "Delete a query's corpus and resume state, keeping its run history.",
)]
final class DiscoveryResetCommand extends Command
{
    public function __construct(
        private readonly DiscoveryExplorer $explorer,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addOption('query', 'q', InputOption::VALUE_REQUIRED, 'The query to reset')
            ->addOption('all', null, InputOption::VALUE_NONE, 'Reset every query')
            ->addOption('include-runs', null, InputOption::VALUE_NONE, 'Delete the run history too')
            ->addOption('yes', 'y', InputOption::VALUE_NONE, 'Skip the confirmation prompt')
            ->setHelp(
                "This data is NOT rebuildable offline: the next sweep re-queries GitHub Search.\n".
                "The run history is kept by default — it is the one table nothing can\n".
                "reconstruct, and a reset is when you most want to read it. --include-runs deletes it.\n".
                'There is no default target: pass --query or --all.',
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $queryOption = $input->getOption('query');
        $query = \is_string($queryOption) ? $queryOption : null;
        $all = true === $input->getOption('all');
        $includeRuns = true === $input->getOption('include-runs');
        $yes = true === $input->getOption('yes');

        try {
            $plans = $this->explorer->planReset($query, $all, $includeRuns);
        } catch (\InvalidArgumentException $e) {
            $io->error($e->getMessage());

            return Command::FAILURE;
        }

        if ([] === $plans) {
            $io->text('nothing to reset — no discovery data matches that target');

            return Command::SUCCESS;
        }

        $io->table(
            ['query', 'repos', 'runs', 'run history'],
            array_map(static fn (ResetPlan $plan): array => [
                $plan->query,
                (string) $plan->repos,
                (string) $plan->runs,
                $plan->deleteRuns ? 'DELETED' : 'kept',
            ], $plans),
        );

        if (!$yes && !$io->confirm('Apply this reset?', false)) {
            $io->text('aborted');

            return Command::SUCCESS;
        }

        $this->explorer->applyReset($plans);
        $io->success(\sprintf('reset %d quer%s', \count($plans), 1 === \count($plans) ? 'y' : 'ies'));

        return Command::SUCCESS;
    }
}
