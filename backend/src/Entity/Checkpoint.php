<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\CheckpointRepository;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Component\Uid\Ulid;

/**
 * One consumer's resume position in the journal (AGENTS.md §3): `{ last_event_id, updated_at }`
 * keyed by `consumer_name`, replacing `checkpoints/{consumer}.json`. `last_event_id` is null
 * for a consumer that has never advanced, so it reads the journal from the very start.
 */
#[ORM\Entity(repositoryClass: CheckpointRepository::class)]
#[ORM\Table(name: 'checkpoints')]
class Checkpoint
{
    #[ORM\Id]
    #[ORM\Column(name: 'consumer_name', length: 128)]
    private string $consumerName;

    #[ORM\Column(name: 'last_event_id', type: 'ulid', nullable: true)]
    private ?Ulid $lastEventId;

    #[ORM\Column(name: 'updated_at', type: 'datetime_immutable')]
    private \DateTimeImmutable $updatedAt;

    public function __construct(string $consumerName, ?Ulid $lastEventId = null)
    {
        $this->consumerName = $consumerName;
        $this->lastEventId = $lastEventId;
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function getConsumerName(): string
    {
        return $this->consumerName;
    }

    public function getLastEventId(): ?Ulid
    {
        return $this->lastEventId;
    }

    public function getUpdatedAt(): \DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function advanceTo(Ulid $lastEventId): void
    {
        $this->lastEventId = $lastEventId;
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function reset(): void
    {
        $this->lastEventId = null;
        $this->updatedAt = new \DateTimeImmutable();
    }
}
