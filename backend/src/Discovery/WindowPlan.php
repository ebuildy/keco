<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * What to do with a window once its probe page has come back. Ported from `plan.ts`'s
 * `WindowPlan` type.
 */
final readonly class WindowPlan
{
    /**
     * @param int          $lastPage  Last page to fetch, inclusive. Page 1 is the probe the
     *                                caller has already spent, so `lastPage === 1` means
     *                                "nothing more to fetch for this window".
     * @param list<Window> $children  Sub-windows to enqueue. Empty when the window fits, or
     *                                when it has hit the day floor.
     * @param bool         $truncated The window is over the cap and cannot be subdivided
     *                                further — results are lost.
     */
    public function __construct(
        public int $lastPage,
        public array $children,
        public bool $truncated,
    ) {
    }
}
