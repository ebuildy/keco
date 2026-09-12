<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\DiscoveryRepoRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * One repo discovery's GitHub Search sweeps found for one query, replacing the TS
 * `discovery_repos` collection (`apps/workers/src/discovery/store/collections.ts`'s `DetailDoc`
 * + `RepoDocumentContext`, migration design spec §3).
 *
 * `id` is the composite `"{querySlug}_{repoId}"` — see `App\Discovery\QuerySlug::repoId()` —
 * the same scheme the TS store used so two queries sharing a repo cannot collide.
 */
#[ORM\Entity(repositoryClass: DiscoveryRepoRepository::class)]
#[ORM\Table(name: 'discovery_repos')]
#[ORM\Index(columns: ['query_slug'], name: 'idx_discovery_repos_query_slug')]
#[ORM\Index(columns: ['stars'], name: 'idx_discovery_repos_stars')]
class DiscoveryRepo
{
    #[ORM\Id]
    #[ORM\Column(length: 140)]
    private string $id;

    #[ORM\Column(name: 'repo_id')]
    private int $repoId;

    #[ORM\Column(name: 'query_slug', length: 100)]
    private string $querySlug;

    #[ORM\Column(length: 255)]
    private string $query;

    #[ORM\Column(name: 'full_name', length: 255)]
    private string $fullName;

    #[ORM\Column(length: 255)]
    private string $name;

    #[ORM\Column(length: 255)]
    private string $owner;

    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $description;

    #[ORM\Column(length: 500, nullable: true)]
    private ?string $homepage;

    #[ORM\Column]
    private int $stars;

    #[ORM\Column]
    private int $forks;

    #[ORM\Column(name: 'open_issues')]
    private int $openIssues;

    #[ORM\Column(length: 100, nullable: true)]
    private ?string $language;

    #[ORM\Column(length: 100, nullable: true)]
    private ?string $license;

    /**
     * @var list<string>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $topics;

    #[ORM\Column]
    private bool $archived;

    #[ORM\Column]
    private bool $fork;

    #[ORM\Column(name: 'default_branch', length: 255)]
    private string $defaultBranch;

    /** Verbatim GitHub timestamps — carried through as strings, never parsed here (AGENTS.md §3). */
    #[ORM\Column(name: 'github_created_at', length: 40)]
    private string $githubCreatedAt;

    #[ORM\Column(name: 'github_updated_at', length: 40)]
    private string $githubUpdatedAt;

    #[ORM\Column(name: 'github_pushed_at', length: 40, nullable: true)]
    private ?string $githubPushedAt;

    /** The window query string that first recorded this sighting (first-wins, see DiscoveryStore). */
    #[ORM\Column(name: 'discovered_via', length: 500)]
    private string $discoveredVia;

    #[ORM\Column(name: 'discovered_at', type: Types::DATETIME_IMMUTABLE)]
    private \DateTimeImmutable $discoveredAt;

    /** Change signal: unchanged ⇒ not rewritten. See `App\Discovery\Store\PayloadHash`. */
    #[ORM\Column(name: 'payload_hash', length: 32)]
    private string $payloadHash;

    #[ORM\Column(name: 'first_seen_run_id', length: 32)]
    private string $firstSeenRunId;

    #[ORM\Column(name: 'last_seen_run_id', length: 32)]
    private string $lastSeenRunId;

    /**
     * @param list<string> $topics
     */
    public function __construct(
        string $id,
        int $repoId,
        string $querySlug,
        string $query,
        string $fullName,
        string $name,
        string $owner,
        ?string $description,
        ?string $homepage,
        int $stars,
        int $forks,
        int $openIssues,
        ?string $language,
        ?string $license,
        array $topics,
        bool $archived,
        bool $fork,
        string $defaultBranch,
        string $githubCreatedAt,
        string $githubUpdatedAt,
        ?string $githubPushedAt,
        string $discoveredVia,
        \DateTimeImmutable $discoveredAt,
        string $payloadHash,
        string $firstSeenRunId,
        string $lastSeenRunId,
    ) {
        $this->id = $id;
        $this->repoId = $repoId;
        $this->querySlug = $querySlug;
        $this->query = $query;
        $this->fullName = $fullName;
        $this->name = $name;
        $this->owner = $owner;
        $this->description = $description;
        $this->homepage = $homepage;
        $this->stars = $stars;
        $this->forks = $forks;
        $this->openIssues = $openIssues;
        $this->language = $language;
        $this->license = $license;
        $this->topics = $topics;
        $this->archived = $archived;
        $this->fork = $fork;
        $this->defaultBranch = $defaultBranch;
        $this->githubCreatedAt = $githubCreatedAt;
        $this->githubUpdatedAt = $githubUpdatedAt;
        $this->githubPushedAt = $githubPushedAt;
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

    public function getRepoId(): int
    {
        return $this->repoId;
    }

    public function getQuerySlug(): string
    {
        return $this->querySlug;
    }

    public function getFullName(): string
    {
        return $this->fullName;
    }

    public function getStars(): int
    {
        return $this->stars;
    }

    public function getLanguage(): ?string
    {
        return $this->language;
    }

    public function getPushedAt(): ?string
    {
        return $this->githubPushedAt;
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
     * Rewrites every field a fresh sighting can change, in place — used when a repo already
     * known to this query resurfaces with a different `payloadHash` (AGENTS.md §4.1's
     * "first-wins" rule only applies to `discoveredVia`/`discoveredAt`/`firstSeenRunId`, which
     * this method deliberately leaves untouched).
     *
     * @param list<string> $topics
     */
    public function updateSighting(
        string $fullName,
        string $name,
        string $owner,
        ?string $description,
        ?string $homepage,
        int $stars,
        int $forks,
        int $openIssues,
        ?string $language,
        ?string $license,
        array $topics,
        bool $archived,
        bool $fork,
        string $defaultBranch,
        string $githubCreatedAt,
        string $githubUpdatedAt,
        ?string $githubPushedAt,
        string $payloadHash,
        string $lastSeenRunId,
    ): void {
        $this->fullName = $fullName;
        $this->name = $name;
        $this->owner = $owner;
        $this->description = $description;
        $this->homepage = $homepage;
        $this->stars = $stars;
        $this->forks = $forks;
        $this->openIssues = $openIssues;
        $this->language = $language;
        $this->license = $license;
        $this->topics = $topics;
        $this->archived = $archived;
        $this->fork = $fork;
        $this->defaultBranch = $defaultBranch;
        $this->githubCreatedAt = $githubCreatedAt;
        $this->githubUpdatedAt = $githubUpdatedAt;
        $this->githubPushedAt = $githubPushedAt;
        $this->payloadHash = $payloadHash;
        $this->lastSeenRunId = $lastSeenRunId;
    }
}
