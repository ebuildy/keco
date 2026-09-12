<?php

declare(strict_types=1);

namespace App\Discovery\Console;

use App\Entity\DiscoveryRepo;
use App\Entity\DiscoveryRun;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/** `app:discovery:list` — list discovery runs (default) or discovered repos. */
#[AsCommand(
    name: 'app:discovery:list',
    description: 'List discovery runs (default) or discovered repos.',
)]
final class DiscoveryListCommand extends Command
{
    public function __construct(
        private readonly DiscoveryExplorer $explorer,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addArgument('target', InputArgument::OPTIONAL, 'runs or repos', 'runs')
            ->addOption('query', 'q', InputOption::VALUE_REQUIRED, 'Narrow to one query')
            ->addOption('limit', 'l', InputOption::VALUE_REQUIRED, 'Rows to show', '20')
            ->addOption('sort', 's', InputOption::VALUE_REQUIRED, 'Override the default ordering (field[:asc|desc])')
            ->addOption('json', null, InputOption::VALUE_NONE, 'Emit NDJSON to stdout instead of a table')
            ->setHelp(
                "Defaults to `runs`: the sweep history is what this exists to expose — new repos\n".
                "found, how long it took, how many GitHub Search calls it cost.\n".
                '--sort accepts any field the target declares sortable; anything else is rejected by name.',
            );
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        $targetArgument = $input->getArgument('target');
        $target = \is_string($targetArgument) ? $targetArgument : 'runs';
        if ('runs' !== $target && 'repos' !== $target) {
            $io->error(\sprintf('list target must be runs or repos, got "%s"', $target));

            return Command::INVALID;
        }

        $queryOption = $input->getOption('query');
        $query = \is_string($queryOption) ? $queryOption : null;

        $limitOption = $input->getOption('limit');
        $limit = \is_string($limitOption) ? (int) $limitOption : 20;

        $sortOption = $input->getOption('sort');
        $sort = \is_string($sortOption) ? $sortOption : null;

        $json = true === $input->getOption('json');

        try {
            return 'runs' === $target
                ? $this->executeRuns($io, $output, $query, $limit, $sort, $json)
                : $this->executeRepos($io, $output, $query, $limit, $sort, $json);
        } catch (\InvalidArgumentException $e) {
            $io->error($e->getMessage());

            return Command::FAILURE;
        }
    }

    private function executeRuns(SymfonyStyle $io, OutputInterface $output, ?string $query, int $limit, ?string $sort, bool $json): int
    {
        $result = $this->explorer->listRuns($query, $limit, $sort);

        if ($json) {
            foreach ($result->rows as $run) {
                $output->writeln(json_encode(self::runToArray($run), \JSON_THROW_ON_ERROR));
            }

            return Command::SUCCESS;
        }

        if ([] === $result->rows) {
            $io->text('no runs yet');

            return Command::SUCCESS;
        }

        $io->table(
            ['started', 'duration (ms)', 'outcome', 'new', 'changed', 'pages', 'windows'],
            array_map(static fn (DiscoveryRun $run): array => [
                $run->getStartedAt()->format('Y-m-d H:i'),
                null === $run->getDurationMs() ? '—' : (string) $run->getDurationMs(),
                $run->getOutcome(),
                (string) $run->getReposNew(),
                (string) $run->getReposChanged(),
                (string) $run->getPagesFetched(),
                \sprintf('%d%s', $run->getWindowsCompleted(), $run->getWindowsFailed() > 0 ? " ({$run->getWindowsFailed()} failed)" : ''),
            ], $result->rows),
        );
        $this->showingLine($io, \count($result->rows), $result->total);

        return Command::SUCCESS;
    }

    private function executeRepos(SymfonyStyle $io, OutputInterface $output, ?string $query, int $limit, ?string $sort, bool $json): int
    {
        $result = $this->explorer->listRepos($query, $limit, $sort);

        if ($json) {
            foreach ($result->rows as $repo) {
                $output->writeln(json_encode(self::repoToArray($repo), \JSON_THROW_ON_ERROR));
            }

            return Command::SUCCESS;
        }

        if ([] === $result->rows) {
            $io->text('no repos discovered yet');

            return Command::SUCCESS;
        }

        $io->table(
            ['stars', 'repo', 'language', 'pushed at'],
            array_map(static fn (DiscoveryRepo $repo): array => [
                (string) $repo->getStars(),
                $repo->getFullName(),
                $repo->getLanguage() ?? '—',
                $repo->getPushedAt() ?? '—',
            ], $result->rows),
        );
        $this->showingLine($io, \count($result->rows), $result->total);

        return Command::SUCCESS;
    }

    private function showingLine(SymfonyStyle $io, int $shown, int $total): void
    {
        if ($shown < $total) {
            $io->text(\sprintf('showing %d of %d — raise with --limit, or pipe --json', $shown, $total));
        }
    }

    /**
     * @return array<string, mixed>
     */
    private static function runToArray(DiscoveryRun $run): array
    {
        return [
            'run_id' => (string) $run->getId(),
            'query_slug' => $run->getQuerySlug(),
            'started_at' => $run->getStartedAt()->format(\DateTimeInterface::ATOM),
            'ended_at' => $run->getEndedAt()?->format(\DateTimeInterface::ATOM),
            'duration_ms' => $run->getDurationMs(),
            'outcome' => $run->getOutcome(),
            'repos_new' => $run->getReposNew(),
            'repos_changed' => $run->getReposChanged(),
            'pages_fetched' => $run->getPagesFetched(),
            'windows_completed' => $run->getWindowsCompleted(),
            'windows_failed' => $run->getWindowsFailed(),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function repoToArray(DiscoveryRepo $repo): array
    {
        return [
            'id' => $repo->getId(),
            'full_name' => $repo->getFullName(),
            'stars' => $repo->getStars(),
            'language' => $repo->getLanguage(),
            'pushed_at' => $repo->getPushedAt(),
        ];
    }
}
