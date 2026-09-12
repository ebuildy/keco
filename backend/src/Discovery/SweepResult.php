<?php

declare(strict_types=1);

namespace App\Discovery;

/** What one `DiscoverySweepRunner::run()` call produced — mirrors `runDiscovery`'s summary log. */
final readonly class SweepResult
{
    public function __construct(
        public string $runId,
        public bool $resuming,
        public int $reposTotal,
        public int $windowsCompleted,
        public int $windowsFailed,
        public int $windowsPending,
        public int $pagesFetched,
        public int $droppedItems,
        public bool $stoppedAtLimit,
        public bool $success,
    ) {
    }
}
