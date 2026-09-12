<?php

declare(strict_types=1);

namespace App\Discovery\Store;

use App\Discovery\FailedWindow;
use App\Discovery\SweepState;
use App\Discovery\Window;
use App\Entity\DiscoveryState;

/**
 * Converts between the Doctrine-backed {@see DiscoveryState} row and the pure, Doctrine-free
 * {@see SweepState} DTO {@see \App\Discovery\Sweep} operates on. `deptrac.yaml` only allows
 * `Entity -> Repository`, so this conversion lives here rather than on the entity itself.
 */
final class SweepStateMapper
{
    private function __construct()
    {
    }

    public static function fromEntity(DiscoveryState $entity): SweepState
    {
        return new SweepState(
            query: $entity->getQuery(),
            startedAt: $entity->getStartedAt()->format('Y-m-d\TH:i:s.v\Z'),
            pendingWindows: array_map(Window::fromArray(...), $entity->getPendingWindows()),
            completedWindows: $entity->getCompletedWindows(),
            failedWindows: array_map(FailedWindow::fromArray(...), $entity->getFailedWindows()),
            reposSeen: $entity->getReposSeen(),
            pagesFetched: $entity->getPagesFetched(),
            dropped: $entity->getDropped(),
        );
    }

    public static function newState(string $query, \DateTimeImmutable $startedAt): SweepState
    {
        return new SweepState(query: $query, startedAt: $startedAt->format('Y-m-d\TH:i:s.v\Z'));
    }

    /**
     * @return list<array<string, mixed>>
     */
    public static function pendingWindowsToArray(SweepState $state): array
    {
        return array_map(static fn (Window $w): array => $w->toArray(), $state->pendingWindows);
    }

    /**
     * @return list<array{window: string, error: string}>
     */
    public static function failedWindowsToArray(SweepState $state): array
    {
        return array_map(static fn (FailedWindow $w): array => $w->toArray(), $state->failedWindows);
    }
}
