<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * The clock discovery's I/O-adjacent services sleep on and read "now" from — injected so tests
 * never actually sleep. Used by {@see Search\GitHubSearchClient} for backoff/throttle waits and
 * by {@see Store\DiscoveryStore} for its flush cadence, mirroring `search.ts`'s `Clock` type.
 */
interface Clock
{
    /** Milliseconds since the epoch. */
    public function now(): int;

    public function sleep(int $milliseconds): void;
}
