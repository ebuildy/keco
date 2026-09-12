<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery;

use App\Discovery\Created;
use App\Discovery\Plan;
use App\Discovery\Window;
use App\Discovery\Windows;
use PHPUnit\Framework\TestCase;

/**
 * Ported test-by-test from `apps/workers/src/discovery/plan.test.ts`.
 */
final class PlanTest extends TestCase
{
    private static function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('2026-08-02T09:30:00Z');
    }

    private static function window(?Created $created = null): Window
    {
        return new Window('kubernetes', '0', $created);
    }

    public function testPaginatesToExhaustionWhenTheWindowFitsUnderTheCap(): void
    {
        $plan = Plan::window(self::window(), 250, self::now());

        self::assertSame(3, $plan->lastPage);
        self::assertSame([], $plan->children);
        self::assertFalse($plan->truncated);
    }

    public function testSpendsOnlyTheProbePageOnAnEmptyWindow(): void
    {
        self::assertSame(1, Plan::window(self::window(), 0, self::now())->lastPage);
    }

    public function testTreatsExactlyTheCapAsFitting(): void
    {
        $plan = Plan::window(self::window(), Plan::MAX_RESULTS_PER_QUERY, self::now());

        self::assertSame(\intdiv(Plan::MAX_RESULTS_PER_QUERY, Plan::PER_PAGE), $plan->lastPage);
        self::assertSame([], $plan->children);
        self::assertFalse($plan->truncated);
    }

    public function testSplitsInsteadOfPaginatingWhenTheWindowIsOverTheCap(): void
    {
        $plan = Plan::window(self::window(Created::year(2020)), 40_000, self::now());

        self::assertSame(1, $plan->lastPage);
        self::assertFalse($plan->truncated);
        self::assertSame([
            ['kind' => 'quarter', 'year' => 2020, 'quarter' => 1],
            ['kind' => 'quarter', 'year' => 2020, 'quarter' => 2],
            ['kind' => 'quarter', 'year' => 2020, 'quarter' => 3],
            ['kind' => 'quarter', 'year' => 2020, 'quarter' => 4],
        ], array_map(static fn (Window $w): array => $w->created?->toArray() ?? [], $plan->children));
    }

    public function testExpandsAnUnconstrainedWindowAgainstTheInjectedClockNotTheWallClock(): void
    {
        $plan = Plan::window(self::window(), 400_000, new \DateTimeImmutable('2031-06-01T00:00:00Z'));

        $last = $plan->children[\count($plan->children) - 1];
        self::assertSame(['kind' => 'year', 'year' => 2031], $last->created?->toArray());
    }

    public function testTakesTheFull1000AndReportsTruncationAtTheDayFloor(): void
    {
        $plan = Plan::window(self::window(Created::day('2020-04-17')), 4_200, self::now());

        self::assertSame(\intdiv(Plan::MAX_RESULTS_PER_QUERY, Plan::PER_PAGE), $plan->lastPage);
        self::assertSame([], $plan->children);
        self::assertTrue($plan->truncated);
    }

    public function testNeverPlansAPagePastThe1000ResultCapAtAnyPageSize(): void
    {
        foreach ([1, 7, 30, 33, 50, 64, 100] as $perPage) {
            foreach ([0, 1, 99, 100, 999, 1000, 1001, 40_000] as $total) {
                $plan = Plan::window(self::window(Created::day('2020-04-17')), $total, self::now(), $perPage);
                self::assertLessThanOrEqual(Plan::MAX_RESULTS_PER_QUERY, $plan->lastPage * $perPage);
                self::assertGreaterThanOrEqual(1, $plan->lastPage);
            }
        }
    }

    public function testTakesAsManyWholePagesAsFitUnderTheCapAtAnUnevenPageSize(): void
    {
        $plan = Plan::window(self::window(Created::day('2020-04-17')), 4_200, self::now(), 30);

        self::assertSame(33, $plan->lastPage);
        self::assertTrue($plan->truncated);
    }

    public function testCarriesBaseAndStarsThroughToEveryChild(): void
    {
        $plan = Plan::window(self::window(Created::quarter(2022, 3)), 2_000, self::now());

        foreach ($plan->children as $child) {
            self::assertSame('kubernetes', $child->base);
            self::assertSame('0', $child->stars);
        }
    }

    /** Sanity: Plan relies on Windows::split, which this pins is still wired up. */
    public function testUsesWindowsSplitForItsChildren(): void
    {
        $window = new Window('kubernetes', '0', Created::year(2020));
        $expected = Windows::split($window, self::now());
        $plan = Plan::window($window, 40_000, self::now());

        self::assertEquals($expected, $plan->children);
    }
}
