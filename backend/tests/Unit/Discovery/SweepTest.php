<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery;

use App\Discovery\FailedWindow;
use App\Discovery\Sweep;
use App\Discovery\SweepState;
use App\Discovery\Window;
use App\Discovery\Windows;
use PHPUnit\Framework\TestCase;

/**
 * Ported test-by-test from `apps/workers/src/discovery/sweep.test.ts`.
 */
final class SweepTest extends TestCase
{
    private static function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('2026-08-02T09:30:00Z');
    }

    public function testResumesAndTouchesNothingWhenWindowsAreStillPending(): void
    {
        $state = new SweepState(
            query: 'kubernetes',
            startedAt: '2026-07-01T00:00:00Z',
            pendingWindows: [new Window('kubernetes', '0', null)],
            completedWindows: ['kubernetes stars:>5000'],
            failedWindows: [new FailedWindow('kubernetes stars:1', 'boom')],
            pagesFetched: 75,
            dropped: 3,
        );

        self::assertTrue(Sweep::begin($state, 'kubernetes', self::now()));
        self::assertCount(1, $state->pendingWindows);
        self::assertSame(['kubernetes stars:>5000'], $state->completedWindows);
        self::assertCount(1, $state->failedWindows);
        self::assertSame(75, $state->pagesFetched);
        self::assertSame(3, $state->dropped);
        self::assertSame('2026-07-01T00:00:00Z', $state->startedAt);
    }

    public function testStartsANewSweepOverEveryStarBandWhenTheQueueIsEmpty(): void
    {
        $state = new SweepState(query: 'kubernetes', startedAt: '2026-07-01T00:00:00Z');

        self::assertFalse(Sweep::begin($state, 'kubernetes', self::now()));
        self::assertCount(\count(Windows::STAR_BANDS), $state->pendingWindows);
        foreach ($state->pendingWindows as $window) {
            self::assertSame('kubernetes', $window->base);
            self::assertNull($window->created);
        }
        self::assertSame('2026-08-02T09:30:00.000Z', $state->startedAt);
    }

    public function testResetsThePerSweepCountersAndWindowBookkeepingOfAFinishedSweep(): void
    {
        // The bug this covers: pagesFetched (and later dropped) carried over from the previous
        // sweep, so the second sweep reported the first one's totals plus its own.
        $state = new SweepState(
            query: 'kubernetes',
            startedAt: '2026-07-01T00:00:00Z',
            completedWindows: ['kubernetes stars:>5000', 'kubernetes stars:0'],
            failedWindows: [new FailedWindow('kubernetes stars:1', 'boom')],
            pagesFetched: 2_140,
            dropped: 17,
        );

        Sweep::begin($state, 'kubernetes', self::now());

        self::assertSame([], $state->completedWindows);
        self::assertSame([], $state->failedWindows);
        self::assertSame(0, $state->pagesFetched);
        self::assertSame(0, $state->dropped);
    }

    public function testLeavesTheCorpusCounterAloneTheRepoListAndHashesSurviveANewSweep(): void
    {
        $state = new SweepState(query: 'kubernetes', startedAt: '2026-07-01T00:00:00Z', reposSeen: 42_904);

        Sweep::begin($state, 'kubernetes', self::now());

        self::assertSame(42_904, $state->reposSeen);
    }

    public function testBuildsTheNewQueueFromTheQueryItIsGivenNotTheOneInState(): void
    {
        $state = new SweepState(query: 'kubernetes', startedAt: '2026-07-01T00:00:00Z');

        Sweep::begin($state, 'istio', self::now());

        foreach ($state->pendingWindows as $window) {
            self::assertSame('istio', $window->base);
        }
    }
}
