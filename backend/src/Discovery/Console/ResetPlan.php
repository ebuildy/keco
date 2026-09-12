<?php

declare(strict_types=1);

namespace App\Discovery\Console;

/** What a reset would destroy, without destroying anything — ported from `explore.ts`'s `ResetPlan`. */
final readonly class ResetPlan
{
    public function __construct(
        public string $query,
        public string $querySlug,
        public int $repos,
        public int $runs,
        public bool $deleteRuns,
    ) {
    }
}
