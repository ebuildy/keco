<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * Everything one sweep of one query tracks between resumes — a plain, mutable, Doctrine-free
 * mirror of `store/collections.ts`'s `DiscoveryState` type. `App\Entity\DiscoveryState` is the
 * Doctrine-backed row this gets serialised into/out of; this class is what {@see Sweep} and the
 * runner operate on, so the resume algebra itself stays testable with no Postgres.
 */
final class SweepState
{
    /**
     * @param list<Window>       $pendingWindows    The live queue, serialised. Without it a
     *                                               resume loses every window produced by
     *                                               subdivision.
     * @param list<string>       $completedWindows
     * @param list<FailedWindow> $failedWindows
     * @param int                $pagesFetched      Pages asked for, not HTTP requests made.
     * @param int                $dropped           Search items GitHub returned that failed
     *                                               per-item validation.
     */
    public function __construct(
        public string $query,
        public string $startedAt,
        public array $pendingWindows = [],
        public array $completedWindows = [],
        public array $failedWindows = [],
        public int $reposSeen = 0,
        public int $pagesFetched = 0,
        public int $dropped = 0,
    ) {
    }
}
