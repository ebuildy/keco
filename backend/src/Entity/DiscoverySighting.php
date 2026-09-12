<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\DiscoverySightingRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * One repo discovery's GitHub Search sweeps found for one query — the `(query_slug, repo_id)`
 * pair, replacing the query-provenance fields the pre-split `GithubRepository` used to carry
 * directly. `id` is the composite `"{querySlug}_{repoId}"` — see `App\Discovery\QuerySlug::repoId()`
 * — the same scheme the pre-split entity used, since it is already exactly the right shape for
 * a per-query sighting row: it lets two queries share one repo without their sighting rows
 * colliding.
 *
 * `ManyToOne` to {@see GithubRepository}, keyed on `repo_id`: the repo's own data lives there,
 * globally deduplicated; this entity holds only this query's relationship to it.
 */
#[ORM\Entity(repositoryClass: DiscoverySightingRepository::class)]
#[ORM\Table(name: 'discovery_sightings')]
#[ORM\Index(columns: ['query_slug'], name: 'idx_discovery_sightings_query_slug')]
class DiscoverySighting
{
    #[ORM\Id]
    #[ORM\Column(length: 140)]
    private string $id;

    #[ORM\ManyToOne(targetEntity: GithubRepository::class)]
    #[ORM\JoinColumn(name: 'repo_id', referencedColumnName: 'repo_id', nullable: false)]
    private GithubRepository $repository;

    #[ORM\Column(name: 'query_slug', length: 100)]
    private string $querySlug;

    #[ORM\Column(length: 255)]
    private string $query;

    /** The window query string that first recorded this sighting (first-wins, see DiscoveryStore). */
    #[ORM\Column(name: 'discovered_via', length: 500)]
    private string $discoveredVia;

    #[ORM\Column(name: 'discovered_at', type: Types::DATETIME_IMMUTABLE)]
    private \DateTimeImmutable $discoveredAt;

    /**
     * This query's own change signal — separate from {@see GithubRepository::$payloadHash},
     * since two queries might not re-see a repo at the same cadence. See
     * `App\Discovery\Store\PayloadHash`.
     */
    #[ORM\Column(name: 'payload_hash', length: 32)]
    private string $payloadHash;

    #[ORM\Column(name: 'first_seen_run_id', length: 32)]
    private string $firstSeenRunId;

    #[ORM\Column(name: 'last_seen_run_id', length: 32)]
    private string $lastSeenRunId;

    public function __construct(
        string $id,
        GithubRepository $repository,
        string $querySlug,
        string $query,
        string $discoveredVia,
        \DateTimeImmutable $discoveredAt,
        string $payloadHash,
        string $firstSeenRunId,
        string $lastSeenRunId,
    ) {
        $this->id = $id;
        $this->repository = $repository;
        $this->querySlug = $querySlug;
        $this->query = $query;
        $this->discoveredVia = $discoveredVia;
        $this->discoveredAt = $discoveredAt;
        $this->payloadHash = $payloadHash;
        $this->firstSeenRunId = $firstSeenRunId;
        $this->lastSeenRunId = $lastSeenRunId;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getRepository(): GithubRepository
    {
        return $this->repository;
    }

    public function getRepoId(): int
    {
        return $this->repository->getRepoId();
    }

    public function getQuerySlug(): string
    {
        return $this->querySlug;
    }

    public function getQuery(): string
    {
        return $this->query;
    }

    public function getPayloadHash(): string
    {
        return $this->payloadHash;
    }

    public function getFirstSeenRunId(): string
    {
        return $this->firstSeenRunId;
    }

    public function getLastSeenRunId(): string
    {
        return $this->lastSeenRunId;
    }

    /**
     * Rewrites the fields a fresh sighting can change, in place — used when this query already
     * knows this repo and it resurfaces with a different `payloadHash` (AGENTS.md §4.1's
     * "first-wins" rule only applies to `discoveredVia`/`discoveredAt`/`firstSeenRunId`, which
     * this method deliberately leaves untouched).
     */
    public function updateSighting(string $payloadHash, string $lastSeenRunId): void
    {
        $this->payloadHash = $payloadHash;
        $this->lastSeenRunId = $lastSeenRunId;
    }
}
