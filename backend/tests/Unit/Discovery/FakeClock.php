<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery;

use App\Discovery\Clock;

/** A clock that never actually sleeps, and records every wait so a test can assert on it. */
final class FakeClock implements Clock
{
    /** @var list<int> */
    public array $slept = [];

    private int $now;

    public function __construct(int $now = 1_700_000_000_000)
    {
        $this->now = $now;
    }

    public function now(): int
    {
        return $this->now;
    }

    public function sleep(int $milliseconds): void
    {
        $this->slept[] = $milliseconds;
        $this->now += $milliseconds;
    }
}
