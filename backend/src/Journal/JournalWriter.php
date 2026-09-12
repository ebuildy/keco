<?php

declare(strict_types=1);

namespace App\Journal;

use App\Entity\JournalEvent;
use App\Repository\JournalEventRepository;

/**
 * The only way to add a fact to the journal (AGENTS.md §2 rule 7, §3): append, never edit,
 * never delete. One call is one durable, atomic write.
 */
final class JournalWriter
{
    public function __construct(
        private readonly JournalEventRepository $journalEvents,
    ) {
    }

    /**
     * @param array<string, mixed> $payload
     */
    public function append(string $type, ?string $repo, array $payload): JournalEvent
    {
        $event = new JournalEvent($type, $repo, $payload);
        $this->journalEvents->save($event);

        return $event;
    }
}
