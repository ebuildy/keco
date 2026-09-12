<?php

declare(strict_types=1);

namespace App\Worker;

/**
 * The clock a worker's I/O-adjacent services sleep on and read "now" from — injected so tests
 * never actually sleep. Used by `App\Discovery\Search\GitHubSearchClient` for backoff/throttle
 * waits and by `App\Discovery\Store\DiscoveryStore` for its flush cadence, mirroring the TS
 * `Clock` type. Lives under `App\Worker` rather than `App\Discovery` because it carries no
 * discovery-specific knowledge — any bounded context that needs an injectable clock uses this
 * same one (AGENTS.md §4/§7: a bounded-context namespace holds only code that needs that
 * context's domain knowledge).
 */
interface Clock
{
    /** Milliseconds since the epoch. */
    public function now(): int;

    public function sleep(int $milliseconds): void;
}
