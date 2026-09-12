<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * Resume the interrupted sweep, or start a new one. Ported from `apps/workers/src/discovery/sweep.ts`.
 *
 * A non-empty queue means the last sweep was interrupted, so continue it. An empty one means the
 * last sweep finished (or there was none): start over across every window.
 *
 * Which fields reset is the whole point, and it is the part that had a bug in the TS original:
 *  - **window bookkeeping and the per-sweep counters reset.** They describe *this* sweep, so
 *    carrying `pagesFetched` forward from a finished sweep silently inflates the next one.
 *  - **the corpus does not.** `reposSeen` mirrors the store's known-repo map and is untouched
 *    here — that is exactly what lets a second sweep re-check the corpus while still skipping
 *    every document whose payload has not changed.
 *
 * Mutates `$state` in place because it *is* the persisted resume point; returns whether this is
 * a resume, for logging.
 */
final class Sweep
{
    private function __construct()
    {
    }

    public static function begin(SweepState $state, string $query, \DateTimeImmutable $now): bool
    {
        if (\count($state->pendingWindows) > 0) {
            return true;
        }

        $state->pendingWindows = Windows::initial($query);
        $state->completedWindows = [];
        $state->failedWindows = [];
        $state->startedAt = self::isoString($now);
        $state->pagesFetched = 0;
        $state->dropped = 0;

        return false;
    }

    private static function isoString(\DateTimeImmutable $now): string
    {
        return $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }
}
