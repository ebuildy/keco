<?php

declare(strict_types=1);

namespace App\Discovery\MessageHandler;

use App\Discovery\DiscoverySweepRunner;
use App\Discovery\Message\SweepDiscoveryQuery;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

/**
 * Consumes `async_discovery`. A single sweep either completes or records a `failed`/`interrupted`
 * `DiscoveryRun` itself (AGENTS.md §4.1) — there is nothing left for Messenger's own retry policy
 * to do, so this handler never rethrows into it.
 */
#[AsMessageHandler]
final class SweepDiscoveryQueryHandler
{
    public function __construct(
        private readonly DiscoverySweepRunner $runner,
    ) {
    }

    public function __invoke(SweepDiscoveryQuery $message): void
    {
        $this->runner->run($message->query, $message->limit, $message->fresh);
    }
}
