<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\GithubRepositoryRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * The unique record of a GitHub repository — one row per actual repo, globally, full stop.
 *
 * PK is GitHub's own numeric repo id, never a composite of query and repo — the same repo
 * discovered by two different queries is the same row here. Holds only the latest known
 * snapshot of the repo itself; no query provenance (that belongs to {@see DiscoverySighting}).
 * Replaces the pre-split `GithubRepository` that was keyed by `"{querySlug}_{repoId}"`, which
 * let the same repo appear as multiple rows — see AGENTS.md §4.1's "one row per repo, full
 * stop" policy and the migration design spec §3.
 */
#[ORM\Entity(repositoryClass: GithubRepositoryRepository::class)]
#[ORM\Table(name: 'github_repositories')]
#[ORM\Index(columns: ['stars'], name: 'idx_github_repositories_stars')]
class GithubRepository
{
    #[ORM\Id]
    #[ORM\Column(name: 'repo_id')]
    #[ORM\GeneratedValue(strategy: 'NONE')]
    private int $repoId;

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

    /**
     * The latest known change signal for this repo's own snapshot — distinct from any single
     * query's {@see DiscoverySighting::$payloadHash}, since two queries might not re-see a repo
     * at the same cadence. See `App\Discovery\Store\PayloadHash`.
     */
    #[ORM\Column(name: 'payload_hash', length: 32)]
    private string $payloadHash;

    /**
     * @param list<string> $topics
     */
    public function __construct(
        int $repoId,
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
    ) {
        $this->repoId = $repoId;
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
    }

    public function getRepoId(): int
    {
        return $this->repoId;
    }

    public function getFullName(): string
    {
        return $this->fullName;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function getOwner(): string
    {
        return $this->owner;
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

    /**
     * Rewrites every field the latest sighting can change, in place — used when this repo's
     * snapshot is stale relative to a freshly discovered payload, regardless of which query
     * found it (AGENTS.md §4.1: "always overwrite with the latest data regardless of which
     * query saw it; skip the write only if payload_hash is unchanged").
     *
     * @param list<string> $topics
     */
    public function updateSnapshot(
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
    }
}
