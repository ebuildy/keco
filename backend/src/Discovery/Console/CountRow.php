<?php

declare(strict_types=1);

namespace App\Discovery\Console;

use App\Entity\DiscoveryRun;

/** One row of `app:discovery:count`'s table, ported from `explore.ts`'s `CountRow`. */
final readonly class CountRow
{
    public function __construct(
        public string $query,
        public string $querySlug,
        public int $repos,
        public int $runs,
        public int $pendingWindows,
        public ?DiscoveryRun $lastRun,
    ) {
    }
}
