<?php

declare(strict_types=1);

namespace App\Discovery;

use App\Discovery\Search\GitHubSearchClient;
use App\Discovery\Store\DiscoveryStore;
use App\Discovery\Store\OpenOptions;
use App\Repository\DiscoveryRepoRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoveryStateRepository;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;

/**
 * discovery — GitHub Search → `DiscoveryRepo`/`DiscoveryRun`/`DiscoveryState` (design
 * 2026-08-02), ported from `apps/workers/src/discovery/index.ts`'s `runDiscovery`.
 *
 * Thin by construction, same as the TS original: the window algebra is {@see Windows}, the
 * split/paginate decision is {@see Plan}, the resume-vs-new-sweep decision is {@see Sweep}, all
 * persistence is {@see DiscoveryStore}. This class is only the orchestration loop plus the
 * signal-handling wiring for a graceful interruption.
 */
final class DiscoverySweepRunner
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DiscoveryRepoRepository $repos,
        private readonly DiscoveryRunRepository $runs,
        private readonly DiscoveryStateRepository $states,
        private readonly GitHubSearchClient $search,
        private readonly Clock $clock,
        private readonly LoggerInterface $logger,
    ) {
    }

    /**
     * @param (callable(DiscoveryStore): void)|null $onWindowCompleted Called after every window,
     *                                                                 whether it flushed or not —
     *                                                                 lets a console command
     *                                                                 render a progress bar
     *                                                                 without this class knowing
     *                                                                 about output.
     */
    public function run(
        string $query,
        ?int $limit,
        bool $fresh,
        ?\DateTimeImmutable $now = null,
        ?callable $onWindowCompleted = null,
    ): SweepResult {
        // One clock read for the whole sweep — see Windows::split()'s docblock for why sampling
        // per call is unsafe.
        $now ??= new \DateTimeImmutable();

        $store = DiscoveryStore::open(
            $this->em,
            $this->repos,
            $this->runs,
            $this->states,
            $this->clock,
            $query,
            new OpenOptions(fresh: $fresh, now: $now, limit: $limit),
        );

        $resuming = Sweep::begin($store->state, $query, $now);
        $state = $store->state;

        /** @var array<string, true> */
        $completed = array_fill_keys($state->completedWindows, true);

        InterruptHandler::install(function () use ($store): void {
            // The history has to say the sweep was interrupted, or a killed run is
            // indistinguishable from one that is still going.
            $store->flush();
            $store->finishRun('interrupted');
        });

        $stopped = false;

        try {
            while ([] !== $state->pendingWindows && !$stopped) {
                // Peek, do not shift: the window being worked on must stay in the array until
                // it is recorded complete or failed, so an interruption mid-window persists a
                // state that still lists it as pending rather than silently dropping it.
                $window = $state->pendingWindows[0];
                $q = Windows::queryOf($window);

                if (!isset($completed[$q])) {
                    try {
                        $this->sweepWindow($store, $window, $q, $now, $state->pendingWindows);
                        $completed[$q] = true;
                        $state->completedWindows[] = $q;
                    } catch (\Throwable $e) {
                        // One bad window never aborts a sweep (AGENTS.md §13).
                        $state->failedWindows[] = new FailedWindow($q, $e->getMessage());
                        $this->logger->error('discovery: window failed', ['window' => $q, 'error' => $e->getMessage()]);
                    }
                }

                array_shift($state->pendingWindows);
                $store->windowCompleted();

                if (null !== $onWindowCompleted) {
                    $onWindowCompleted($store);
                }

                if (null !== $limit && $store->size() >= $limit) {
                    $stopped = true;
                }
            }
        } finally {
            $store->flush();
        }

        $failed = \count($state->failedWindows);
        $result = new SweepResult(
            runId: $store->runId,
            resuming: $resuming,
            reposTotal: $store->size(),
            windowsCompleted: \count($completed),
            windowsFailed: $failed,
            windowsPending: \count($state->pendingWindows),
            pagesFetched: $state->pagesFetched,
            droppedItems: $state->dropped,
            stoppedAtLimit: $stopped,
            success: 0 === $failed,
        );

        if ($failed > 0) {
            // A failed window is a silently truncated corpus. Exiting successfully would let a
            // scheduled sweep hand the crawler an incomplete corpus and call it a success.
            $store->finishRun('failed', new \DateTimeImmutable(), $stopped);
            $this->logger->error('discovery: finished with failed windows — the corpus is incomplete', [
                'run_id' => $result->runId,
                'windows_failed' => $failed,
            ]);

            return $result;
        }

        $store->finishRun('complete', new \DateTimeImmutable(), $stopped);
        $this->logger->info('discovery: complete', [
            'run_id' => $result->runId,
            'repos' => $result->reposTotal,
            'windows_completed' => $result->windowsCompleted,
        ]);

        return $result;
    }

    /**
     * @param list<Window> $queue Only read here (for `array_push`'s target) — never shifted; the
     *                            caller owns that.
     */
    private function sweepWindow(DiscoveryStore $store, Window $window, string $query, \DateTimeImmutable $now, array &$queue): void
    {
        $state = $store->state;

        ++$state->pagesFetched;
        $probe = $this->search->page($query, 1, Plan::PER_PAGE);
        $state->dropped += $probe->dropped;
        $this->recordAll($store, $probe->items, $query, $now);

        $plan = Plan::window($window, $probe->totalCount, $now);
        if ($plan->truncated) {
            $this->logger->warning('discovery: window exceeds 1000 at day granularity — truncated', [
                'window' => $query,
                'total_count' => $probe->totalCount,
            ]);
        }

        for ($page = 2; $page <= $plan->lastPage; ++$page) {
            ++$state->pagesFetched;
            $next = $this->search->page($query, $page, Plan::PER_PAGE);
            $state->dropped += $next->dropped;
            $this->recordAll($store, $next->items, $query, $now);
        }

        if ([] !== $plan->children) {
            array_push($queue, ...$plan->children);
        }
    }

    /**
     * @param list<\App\Discovery\Search\SearchItem> $items
     */
    private function recordAll(DiscoveryStore $store, array $items, string $via, \DateTimeImmutable $now): void
    {
        foreach ($items as $item) {
            try {
                $store->record($item, $via, $now);
            } catch (\Throwable $e) {
                $this->logger->warning('discovery: could not record repo', [
                    'repo' => $item->fullName,
                    'error' => $e->getMessage(),
                ]);
            }
        }
    }
}
