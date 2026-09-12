<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery;

use App\Discovery\Created;
use App\Discovery\Window;
use App\Discovery\Windows;
use PHPUnit\Framework\TestCase;

/**
 * Ported test-by-test from `apps/workers/src/discovery/windows.test.ts` (AGENTS.md §4.1 /
 * migration plan Phase 1). Test names mirror the TS `it()` descriptions so parity is auditable.
 */
final class WindowsTest extends TestCase
{
    private static function now(string $iso = '2026-08-02T00:00:00Z'): \DateTimeImmutable
    {
        return new \DateTimeImmutable($iso);
    }

    private static function band(string $stars): Window
    {
        return new Window('kubernetes', $stars, null);
    }

    /**
     * If these ever collide, the pre-2014 "years" bucket degenerates to from === to and its
     * only child (a single `year`) renders the exact same query string as its parent — silently
     * breaking resume. `windows.ts` throws at module load; PHP has no equivalent hook, so this
     * invariant is pinned by a test instead (PHPStan already proves the current constants can
     * never trip it, which is why there is no runtime guard in {@see Windows} itself).
     */
    public function testGithubEpochYearIsBeforeEarlyYearsEnd(): void
    {
        self::assertLessThan(Windows::EARLY_YEARS_END, Windows::GITHUB_EPOCH_YEAR);
    }

    public function testStarBandsCoverEveryStarCountFromZeroUpwardWithNoGapAndNoOverlap(): void
    {
        $bounds = array_map(static function (string $band): array {
            if (str_starts_with($band, '>')) {
                return ['lo' => (int) substr($band, 1) + 1, 'hi' => \PHP_INT_MAX];
            }
            if (str_contains($band, '..')) {
                [$lo, $hi] = explode('..', $band);

                return ['lo' => (int) $lo, 'hi' => (int) $hi];
            }

            return ['lo' => (int) $band, 'hi' => (int) $band];
        }, Windows::STAR_BANDS);

        usort($bounds, static fn (array $a, array $b): int => $a['lo'] <=> $b['lo']);

        self::assertSame(0, $bounds[0]['lo']);
        self::assertSame(\PHP_INT_MAX, $bounds[\count($bounds) - 1]['hi']);
        for ($i = 1; $i < \count($bounds); ++$i) {
            self::assertSame($bounds[$i - 1]['hi'] + 1, $bounds[$i]['lo']);
        }
    }

    public function testInitialWindowsStartsWithOneUnconstrainedWindowPerStarBand(): void
    {
        $windows = Windows::initial('kubernetes');

        self::assertCount(\count(Windows::STAR_BANDS), $windows);
        foreach ($windows as $window) {
            self::assertNull($window->created);
        }
        self::assertSame('kubernetes stars:>5000', Windows::queryOf($windows[0]));
    }

    public function testSplitSplitsAnUnconstrainedBandIntoAPre2014BucketPlusOneWindowPerYear(): void
    {
        $parts = Windows::split(self::band('0'), self::now());

        self::assertSame('kubernetes stars:0 created:2008-01-01..2013-12-31', Windows::queryOf($parts[0]));
        self::assertSame('kubernetes stars:0 created:2014-01-01..2014-12-31', Windows::queryOf($parts[1]));
        self::assertSame('kubernetes stars:0 created:2026-01-01..2026-12-31', Windows::queryOf($parts[\count($parts) - 1]));
        self::assertCount(1 + (2026 - 2013), $parts);
    }

    public function testSplitSplitsThePre2014BucketIntoItsIndividualYears(): void
    {
        $multi = Windows::split(self::band('0'), self::now())[0];
        $parts = Windows::split($multi, self::now());

        self::assertCount(6, $parts);
        self::assertSame('kubernetes stars:0 created:2008-01-01..2008-12-31', Windows::queryOf($parts[0]));
        self::assertSame('kubernetes stars:0 created:2013-01-01..2013-12-31', Windows::queryOf($parts[\count($parts) - 1]));
    }

    public function testSplitSplitsAYearIntoFourCalendarQuarters(): void
    {
        $year = new Window('kubernetes', '0', Created::year(2020));
        $parts = Windows::split($year, self::now());

        self::assertSame([
            'kubernetes stars:0 created:2020-01-01..2020-03-31',
            'kubernetes stars:0 created:2020-04-01..2020-06-30',
            'kubernetes stars:0 created:2020-07-01..2020-09-30',
            'kubernetes stars:0 created:2020-10-01..2020-12-31',
        ], array_map(Windows::queryOf(...), $parts));
    }

    public function testSplitSplitsAQuarterIntoItsThreeMonths(): void
    {
        $quarter = new Window('kubernetes', '0', Created::quarter(2020, 1));

        self::assertSame([
            'kubernetes stars:0 created:2020-01-01..2020-01-31',
            'kubernetes stars:0 created:2020-02-01..2020-02-29',
            'kubernetes stars:0 created:2020-03-01..2020-03-31',
        ], array_map(Windows::queryOf(...), Windows::split($quarter, self::now())));
    }

    public function testSplitSplitsAMonthIntoDaysRespectingLeapYears(): void
    {
        $leap = new Window('kubernetes', '0', Created::month(2020, 2));
        $common = new Window('kubernetes', '0', Created::month(2021, 2));

        self::assertCount(29, Windows::split($leap, self::now()));
        self::assertCount(28, Windows::split($common, self::now()));
        $leapParts = Windows::split($leap, self::now());
        self::assertSame('kubernetes stars:0 created:2020-02-29', Windows::queryOf($leapParts[\count($leapParts) - 1]));
    }

    public function testSplitCannotSplitASingleDayThatIsTheFloor(): void
    {
        $day = new Window('kubernetes', '0', Created::day('2020-02-29'));

        self::assertSame([], Windows::split($day, self::now()));
    }

    public function testSplitProducesTheSameQueriesOnEveryRunSoResumeStateStaysValid(): void
    {
        $monday = Windows::split(Windows::initial('kubernetes')[5], self::now('2026-08-02T00:00:00Z'));
        $tuesday = Windows::split(Windows::initial('kubernetes')[5], self::now('2026-08-03T11:00:00Z'));

        self::assertSame(array_map(Windows::queryOf(...), $monday), array_map(Windows::queryOf(...), $tuesday));
    }

    // --- Exhaustiveness properties -------------------------------------------------------------
    //
    // Independent of the implementation on purpose: `dayIndex`/`coverage` reimplement the
    // interval math from scratch rather than calling `queryOf`/`createdRange`, so a bug in the
    // production interval math doesn't also corrupt the check that's supposed to catch it —
    // exactly mirroring windows.test.ts's rationale for these two properties.

    private static function dayIndex(int $year, int $month1, int $day): int
    {
        $utc = new \DateTimeImmutable(\sprintf('%04d-%02d-%02d', $year, $month1, $day), new \DateTimeZone('UTC'));

        return (int) floor($utc->getTimestamp() / 86_400);
    }

    private static function lastDayOf(int $year, int $month1): int
    {
        return Windows::daysInMonth($year, $month1);
    }

    /**
     * @return array{0: int, 1: int}
     */
    private static function coverage(Window $window, \DateTimeImmutable $now): array
    {
        $created = $window->created;
        if (null === $created) {
            return [self::dayIndex(2008, 1, 1), self::dayIndex((int) $now->format('Y'), 12, 31)];
        }

        return match ($created->kind) {
            'years' => [self::dayIndex($created->fromOf(), 1, 1), self::dayIndex($created->toOf(), 12, 31)],
            'year' => [self::dayIndex($created->yearOf(), 1, 1), self::dayIndex($created->yearOf(), 12, 31)],
            'quarter' => self::quarterCoverage($created),
            'month' => [
                self::dayIndex($created->yearOf(), $created->monthOf(), 1),
                self::dayIndex($created->yearOf(), $created->monthOf(), self::lastDayOf($created->yearOf(), $created->monthOf())),
            ],
            'day' => self::dayCoverage($created->dateOf()),
            default => throw new \LogicException('unreachable'),
        };
    }

    /**
     * @return array{0: int, 1: int}
     */
    private static function quarterCoverage(Created $created): array
    {
        $firstMonth = ($created->quarterOf() - 1) * 3 + 1;
        $lastMonth = $firstMonth + 2;

        return [
            self::dayIndex($created->yearOf(), $firstMonth, 1),
            self::dayIndex($created->yearOf(), $lastMonth, self::lastDayOf($created->yearOf(), $lastMonth)),
        ];
    }

    /**
     * @return array{0: int, 1: int}
     */
    private static function dayCoverage(string $date): array
    {
        [$y, $m, $d] = array_map('intval', explode('-', $date));
        $idx = self::dayIndex($y, $m, $d);

        return [$idx, $idx];
    }

    private static function assertExactPartition(Window $window, \DateTimeImmutable $now): void
    {
        $children = Windows::split($window, $now);
        if ([] === $children) {
            return;
        }

        [$parentStart, $parentEnd] = self::coverage($window, $now);
        $ranges = array_map(static fn (Window $child): array => self::coverage($child, $now), $children);
        usort($ranges, static fn (array $a, array $b): int => $a[0] <=> $b[0]);

        self::assertSame($parentStart, $ranges[0][0]);
        self::assertSame($parentEnd, $ranges[\count($ranges) - 1][1]);
        for ($i = 1; $i < \count($ranges); ++$i) {
            self::assertSame($ranges[$i - 1][1] + 1, $ranges[$i][0]);
        }

        foreach ($children as $child) {
            self::assertExactPartition($child, $now);
        }
    }

    private static function assertRealDates(Window $window, \DateTimeImmutable $now): void
    {
        if (1 === preg_match('/created:(\S+)/', Windows::queryOf($window), $match)) {
            $range = $match[1];
            $endpoints = str_contains($range, '..') ? explode('..', $range) : [$range];
            foreach ($endpoints as $endpoint) {
                [$y, $m, $d] = array_map('intval', explode('-', $endpoint));
                $roundTrip = \DateTimeImmutable::createFromFormat('!Y-m-d', \sprintf('%04d-%02d-%02d', $y, $m, $d), new \DateTimeZone('UTC'));
                self::assertNotFalse($roundTrip);
                self::assertSame([$y, $m, $d], [(int) $roundTrip->format('Y'), (int) $roundTrip->format('n'), (int) $roundTrip->format('j')]);
            }
        }

        foreach (Windows::split($window, $now) as $child) {
            self::assertRealDates($child, $now);
        }
    }

    public function testEveryLevelPartitionsItsParentExactlyAllTheWayToDayLevelLeaves(): void
    {
        $root = Windows::initial('kubernetes')[0];
        self::assertExactPartition($root, self::now());
    }

    public function testEveryRenderedRangeEndpointAtEveryLevelIsARealCalendarDate(): void
    {
        $root = Windows::initial('kubernetes')[0];
        self::assertRealDates($root, self::now());
    }
}
