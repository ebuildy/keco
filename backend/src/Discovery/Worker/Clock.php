<?php

declare(strict_types=1);

namespace App\Discovery\Worker;

/**
 * The clock a worker's I/O-adjacent services sleep on and read "now" from — injected so tests
 * never actually sleep. Used by `App\Discovery\Search\GitHubSearchClient` for backoff/throttle
 * waits and by `App\Discovery\Store\DiscoveryStore` for its flush cadence, mirroring the TS
 * `Clock` type.
 */
interface Clock
{
    /** Milliseconds since the epoch. */
    public function now(): int;

    public function sleep(int $milliseconds): void;
}
