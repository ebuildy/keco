<?php

declare(strict_types=1);

namespace App\Discovery\Console;

/**
 * `$total` is the count *before* the limit, so the caller can say "showing 20 of 31,204" —
 * ported from `explore.ts`'s `ListResult`.
 *
 * @template T
 */
final readonly class ListResult
{
    /**
     * @param list<T> $rows
     */
    public function __construct(
        public array $rows,
        public int $total,
    ) {
    }
}
