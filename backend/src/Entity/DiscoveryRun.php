<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\DiscoveryRunRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Uid\Ulid;

/**
 * One sweep process's history, replacing the TS `discovery_runs` collection
 * (`store/collections.ts`'s `toRunDocument`, migration design spec §3).
 *
 * Written `running` the instant a sweep opens (AGENTS.md §4.1) — a killed process therefore
 * leaves a row at `running` forever, which is the deliberate stuck-row behavior an operator
 * uses to spot a sweep that died without cleanup. Never rewritten after a terminal outcome.
 */
#[ORM\Entity(repositoryClass: DiscoveryRunRepository::class)]
#[ORM\Table(name: 'discovery_runs')]
#[ORM\Index(columns: ['query_slug'], name: 'idx_discovery_runs_query_slug')]
#[ORM\Index(columns: ['outcome'], name: 'idx_discovery_runs_outcome')]
class DiscoveryRun
{
    #[ORM\Id]
    #[ORM\Column(type: 'ulid', unique: true)]
    private Ulid $id;

    #[ORM\Column(length: 255)]
    private string $query;

    #[ORM\Column(name: 'query_slug', length: 100)]
    private string $querySlug;

    #[ORM\Column(name: 'started_at', type: Types::DATETIME_IMMUTABLE)]
    private \DateTimeImmutable $startedAt;

    #[ORM\Column(name: 'ended_at', type: Types::DATETIME_IMMUTABLE, nullable: true)]
    private ?\DateTimeImmutable $endedAt = null;

    #[ORM\Column(name: 'duration_ms', nullable: true)]
    private ?int $durationMs = null;

    /** `running` | `complete` | `failed` | `interrupted`. */
    #[ORM\Column(length: 16)]
    private string $outcome;

    #[ORM\Column]
    private bool $fresh;

    #[ORM\Column(name: 'run_limit', nullable: true)]
    private ?int $limit;

    #[ORM\Column(name: 'pages_fetched')]
    private int $pagesFetched = 0;

    #[ORM\Column]
    private int $dropped = 0;

    #[ORM\Column(name: 'repos_new')]
    private int $reposNew = 0;

    #[ORM\Column(name: 'repos_changed')]
    private int $reposChanged = 0;

    #[ORM\Column(name: 'repos_unchanged')]
    private int $reposUnchanged = 0;

    #[ORM\Column(name: 'windows_completed')]
    private int $windowsCompleted = 0;

    #[ORM\Column(name: 'windows_failed')]
    private int $windowsFailed = 0;

    #[ORM\Column(name: 'sweep_repos_total')]
    private int $sweepReposTotal = 0;

    #[ORM\Column(name: 'sweep_windows_pending')]
    private int $sweepWindowsPending = 0;

    #[ORM\Column(name: 'stopped_at_limit')]
    private bool $stoppedAtLimit = false;

    /**
     * Capped at 50 entries (AGENTS.md §4.1's TS equivalent) so one catastrophic sweep cannot
     * write an unbounded row.
     *
     * @var list<array{window: string, error: string}>
     */
    #[ORM\Column(name: 'failed_windows', type: Types::JSON)]
    private array $failedWindows = [];

    public function __construct(
        Ulid $id,
        string $query,
        string $querySlug,
        \DateTimeImmutable $startedAt,
        bool $fresh,
        ?int $limit,
    ) {
        $this->id = $id;
        $this->query = $query;
        $this->querySlug = $querySlug;
        $this->startedAt = $startedAt;
        $this->fresh = $fresh;
        $this->limit = $limit;
        $this->outcome = 'running';
    }

    public function getId(): Ulid
    {
        return $this->id;
    }

    public function getQuerySlug(): string
    {
        return $this->querySlug;
    }

    public function getOutcome(): string
    {
        return $this->outcome;
    }

    public function getStartedAt(): \DateTimeImmutable
    {
        return $this->startedAt;
    }

    public function getEndedAt(): ?\DateTimeImmutable
    {
        return $this->endedAt;
    }

    /**
     * Run-scoped progress, snapshotted at the moment of the write — never the sweep-scoped
     * totals, which accumulate across every resume (AGENTS.md §4.1).
     *
     * @param list<array{window: string, error: string}> $failedWindows
     */
    public function recordProgress(
        int $pagesFetched,
        int $dropped,
        int $reposNew,
        int $reposChanged,
        int $reposUnchanged,
        int $windowsCompleted,
        int $windowsFailed,
        int $sweepReposTotal,
        int $sweepWindowsPending,
        bool $stoppedAtLimit,
        array $failedWindows,
    ): void {
        $this->pagesFetched = $pagesFetched;
        $this->dropped = $dropped;
        $this->reposNew = $reposNew;
        $this->reposChanged = $reposChanged;
        $this->reposUnchanged = $reposUnchanged;
        $this->windowsCompleted = $windowsCompleted;
        $this->windowsFailed = $windowsFailed;
        $this->sweepReposTotal = $sweepReposTotal;
        $this->sweepWindowsPending = $sweepWindowsPending;
        $this->stoppedAtLimit = $stoppedAtLimit;
        $this->failedWindows = \array_slice($failedWindows, 0, 50);
    }

    /**
     * Stamps a terminal outcome. `running` never reaches here — a killed process leaves the row
     * exactly as `writeRun('running', ...)` left it, deliberately (AGENTS.md §4.1).
     */
    public function finish(string $outcome, \DateTimeImmutable $endedAt): void
    {
        if ('running' === $outcome) {
            throw new \InvalidArgumentException('finish() cannot re-mark a run as "running".');
        }

        $this->outcome = $outcome;
        $this->endedAt = $endedAt;
        $this->durationMs = $endedAt->getTimestamp() * 1000 - $this->startedAt->getTimestamp() * 1000;
    }
}
