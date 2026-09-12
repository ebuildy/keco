<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\DiscoveryStateRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * One query's resume position, replacing the TS `discovery_state` collection
 * (`store/collections.ts`'s `DiscoveryState` / `toStateDocument`, migration design spec §3).
 *
 * Deliberately dumb: `pendingWindows`/`completedWindows`/`failedWindows` are stored as plain
 * JSON arrays, not `App\Discovery\Window`/`FailedWindow` value objects — `deptrac.yaml` only
 * allows `Entity -> Repository`, so the conversion to/from those richer types happens in
 * `App\Discovery\Store\SweepStateMapper`, not here.
 */
#[ORM\Entity(repositoryClass: DiscoveryStateRepository::class)]
#[ORM\Table(name: 'discovery_state')]
class DiscoveryState
{
    #[ORM\Id]
    #[ORM\Column(name: 'query_slug', length: 100)]
    private string $querySlug;

    #[ORM\Column(length: 255)]
    private string $query;

    #[ORM\Column(name: 'started_at', type: Types::DATETIME_IMMUTABLE)]
    private \DateTimeImmutable $startedAt;

    #[ORM\Column(name: 'updated_at', type: Types::DATETIME_IMMUTABLE)]
    private \DateTimeImmutable $updatedAt;

    #[ORM\Column(name: 'current_run_id', length: 32, nullable: true)]
    private ?string $currentRunId;

    /**
     * @var list<array<string, mixed>>
     */
    #[ORM\Column(name: 'pending_windows', type: Types::JSON)]
    private array $pendingWindows;

    /**
     * @var list<string>
     */
    #[ORM\Column(name: 'completed_windows', type: Types::JSON)]
    private array $completedWindows;

    /**
     * @var list<array{window: string, error: string}>
     */
    #[ORM\Column(name: 'failed_windows', type: Types::JSON)]
    private array $failedWindows;

    #[ORM\Column(name: 'repos_seen')]
    private int $reposSeen;

    #[ORM\Column(name: 'pages_fetched')]
    private int $pagesFetched;

    #[ORM\Column]
    private int $dropped;

    /**
     * @param list<array<string, mixed>>              $pendingWindows
     * @param list<string>                            $completedWindows
     * @param list<array{window: string, error: string}> $failedWindows
     */
    public function __construct(
        string $querySlug,
        string $query,
        \DateTimeImmutable $startedAt,
        \DateTimeImmutable $updatedAt,
        ?string $currentRunId,
        array $pendingWindows,
        array $completedWindows,
        array $failedWindows,
        int $reposSeen,
        int $pagesFetched,
        int $dropped,
    ) {
        $this->querySlug = $querySlug;
        $this->query = $query;
        $this->startedAt = $startedAt;
        $this->updatedAt = $updatedAt;
        $this->currentRunId = $currentRunId;
        $this->pendingWindows = $pendingWindows;
        $this->completedWindows = $completedWindows;
        $this->failedWindows = $failedWindows;
        $this->reposSeen = $reposSeen;
        $this->pagesFetched = $pagesFetched;
        $this->dropped = $dropped;
    }

    public function getQuerySlug(): string
    {
        return $this->querySlug;
    }

    public function getQuery(): string
    {
        return $this->query;
    }

    public function getStartedAt(): \DateTimeImmutable
    {
        return $this->startedAt;
    }

    public function getCurrentRunId(): ?string
    {
        return $this->currentRunId;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function getPendingWindows(): array
    {
        return $this->pendingWindows;
    }

    /**
     * @return list<string>
     */
    public function getCompletedWindows(): array
    {
        return $this->completedWindows;
    }

    /**
     * @return list<array{window: string, error: string}>
     */
    public function getFailedWindows(): array
    {
        return $this->failedWindows;
    }

    public function getReposSeen(): int
    {
        return $this->reposSeen;
    }

    public function getPagesFetched(): int
    {
        return $this->pagesFetched;
    }

    public function getDropped(): int
    {
        return $this->dropped;
    }

    /**
     * Replaces the whole snapshot in one call — mirroring the TS store's `toStateDocument`,
     * which always writes every field together rather than patching individual ones.
     *
     * @param list<array<string, mixed>>                 $pendingWindows
     * @param list<string>                                $completedWindows
     * @param list<array{window: string, error: string}> $failedWindows
     */
    public function applySnapshot(
        string $currentRunId,
        \DateTimeImmutable $updatedAt,
        array $pendingWindows,
        array $completedWindows,
        array $failedWindows,
        int $reposSeen,
        int $pagesFetched,
        int $dropped,
    ): void {
        $this->currentRunId = $currentRunId;
        $this->updatedAt = $updatedAt;
        $this->pendingWindows = $pendingWindows;
        $this->completedWindows = $completedWindows;
        $this->failedWindows = $failedWindows;
        $this->reposSeen = $reposSeen;
        $this->pagesFetched = $pagesFetched;
        $this->dropped = $dropped;
    }
}
