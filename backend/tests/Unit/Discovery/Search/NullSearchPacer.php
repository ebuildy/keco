<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery\Search;

use App\Discovery\Search\SearchPacer;

/** A pacer that never waits, and counts how many times it was asked to — for tests only. */
final class NullSearchPacer implements SearchPacer
{
    public int $calls = 0;

    public function pace(): void
    {
        ++$this->calls;
    }
}
