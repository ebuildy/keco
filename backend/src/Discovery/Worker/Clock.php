<?php

declare(strict_types=1);

namespace App\Discovery\Worker;

/**
 * The clock a worker's I/O-adjacent services sleep on and read "now" from — injected so tests
 * never actually sleep. Used by `App\Discovery\Search\GitHubSearchClient` for backoff/throttle
 * waits and by `App\Discovery\Store\DiscoveryStore` for its flush cadence, mirroring the TS
 * `Clock` type. Carries no discovery-specific knowledge, so it's grouped under this context's own
 * `App\Discovery\Worker` sub-namespace rather than mixed into `App\Discovery` proper — but it
 * stays here, not a top-level `App\Worker`, until a second bounded context actually needs an
 * injectable clock too (AGENTS.md §4/§7: move code out of a context the moment a second context
 * needs it, not speculatively before that).
 */
interface Clock
{
    /** Milliseconds since the epoch. */
    public function now(): int;

    public function sleep(int $milliseconds): void;
}
