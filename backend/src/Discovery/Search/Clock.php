<?php

declare(strict_types=1);

namespace App\Discovery\Search;

/**
 * The clock {@see GitHubSearchClient} sleeps on for backoff/throttle waits — injected so tests
 * never actually sleep, mirroring `search.ts`'s `Clock` type.
 */
interface Clock
{
    /** Milliseconds since the epoch. */
    public function now(): int;

    public function sleep(int $milliseconds): void;
}
