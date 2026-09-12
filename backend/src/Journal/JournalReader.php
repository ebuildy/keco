<?php

declare(strict_types=1);

namespace App\Journal;

use App\Entity\JournalEvent;
use App\Repository\JournalEventRepository;
use Symfony\Component\Uid\Ulid;

/**
 * Ordered, resumable reads over the journal (AGENTS.md §3, §14: "never LIST to find work").
 * A consumer's own `Checkpoint` supplies `$after`; this class never looks one up itself, so it
 * stays a pure, indexed range read with no opinion about who is reading.
 */
final class JournalReader
{
    public function __construct(
        private readonly JournalEventRepository $journalEvents,
    ) {
    }

    /**
     * @return list<JournalEvent> events strictly after `$after`, oldest first, capped at `$limit`
     */
    public function readSince(?Ulid $after, int $limit): array
    {
        if ($limit < 1) {
            throw new \InvalidArgumentException('limit must be at least 1.');
        }

        return $this->journalEvents->findSince($after, $limit);
    }
}
