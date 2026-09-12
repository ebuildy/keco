<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\JournalEventRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Uid\Ulid;

/**
 * One fact about the past — append-only, never updated or deleted (AGENTS.md §2 rule 7, §3).
 *
 * Replaces `journal/{date}/{ulid}.json`: the ULID primary key keeps insertion order, so a
 * consumer resumes with `WHERE id > :checkpoint ORDER BY id LIMIT :n` (JournalReader) instead
 * of listing a directory.
 */
#[ORM\Entity(repositoryClass: JournalEventRepository::class)]
#[ORM\Table(name: 'journal_events')]
#[ORM\Index(columns: ['type'], name: 'idx_journal_events_type')]
#[ORM\Index(columns: ['repo'], name: 'idx_journal_events_repo')]
class JournalEvent
{
    #[ORM\Id]
    #[ORM\Column(type: 'ulid', unique: true)]
    private Ulid $id;

    #[ORM\Column(length: 64)]
    private string $type;

    #[ORM\Column(length: 255, nullable: true)]
    private ?string $repo;

    /**
     * @var array<string, mixed>
     */
    #[ORM\Column(type: Types::JSONB)]
    private array $payload;

    #[ORM\Column(type: Types::DATETIME_IMMUTABLE)]
    private \DateTimeImmutable $createdAt;

    /**
     * @param array<string, mixed> $payload
     */
    public function __construct(string $type, ?string $repo, array $payload)
    {
        $this->id = new Ulid();
        $this->type = $type;
        $this->repo = $repo;
        $this->payload = $payload;
        $this->createdAt = new \DateTimeImmutable();
    }

    public function getId(): Ulid
    {
        return $this->id;
    }

    public function getType(): string
    {
        return $this->type;
    }

    public function getRepo(): ?string
    {
        return $this->repo;
    }

    /**
     * @return array<string, mixed>
     */
    public function getPayload(): array
    {
        return $this->payload;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }
}
