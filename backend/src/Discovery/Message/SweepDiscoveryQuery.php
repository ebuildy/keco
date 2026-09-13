<?php

declare(strict_types=1);

namespace App\Discovery\Message;

/**
 * Dispatched by `app:discovery:sweep` or Symfony Scheduler to run one discovery sweep
 * asynchronously, over `async_discovery` (AGENTS.md §4.1).
 */
final readonly class SweepDiscoveryQuery
{
    public function __construct(
        public string $query,
        public ?int $limit = null,
        public bool $fresh = false,
    ) {
    }
}
