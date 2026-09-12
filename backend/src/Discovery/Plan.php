<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * What to do with a window once its probe page has come back (design 2026-08-02), ported from
 * `apps/workers/src/discovery/plan.ts`. Pure, clock-injected, unit-tested.
 */
final class Plan
{
    /** GitHub Search never returns more than this, however many pages you ask for. */
    public const MAX_RESULTS_PER_QUERY = 1000;

    /** GitHub Search's own per-page cap. */
    public const PER_PAGE = 100;

    private function __construct()
    {
    }

    /**
     * Three outcomes, in the order the design specifies:
     *
     *  - **fits** (`total_count <= 1000`): paginate to exhaustion, no children.
     *  - **too big, splittable**: keep the probe's 100 items (dedup absorbs them) and
     *    subdivide. Deliberately does *not* paginate — the children cover the same repos and
     *    pagination here would spend up to nine extra search requests for results we are about
     *    to fetch anyway.
     *  - **too big, at the day floor**: cannot subdivide, so take everything GitHub will give —
     *    all ten pages — and report `truncated` so the caller can warn.
     */
    public static function window(Window $window, int $totalCount, \DateTimeImmutable $now, int $perPage = self::PER_PAGE): WindowPlan
    {
        if ($totalCount <= self::MAX_RESULTS_PER_QUERY) {
            return new WindowPlan(self::pagesFor($totalCount, $perPage), [], false);
        }

        $children = Windows::split($window, $now);
        if (\count($children) > 0) {
            return new WindowPlan(1, $children, false);
        }

        return new WindowPlan(self::pagesFor(self::MAX_RESULTS_PER_QUERY, $perPage), [], true);
    }

    /**
     * At least 1 — the probe page is always spent, even on an empty result set — and never so
     * far that `page * perPage` crosses the 1000-result cap, which `GitHubSearchClient::page()`
     * rejects outright. The ceiling has to be a *floor* division — see `plan.ts`'s comment on
     * why only `PER_PAGE === 100` hides this at the default page size.
     */
    private static function pagesFor(int $count, int $perPage): int
    {
        return max(1, min((int) ceil($count / $perPage), intdiv(self::MAX_RESULTS_PER_QUERY, $perPage)));
    }
}
