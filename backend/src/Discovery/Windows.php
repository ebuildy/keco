<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * Search windows (design 2026-08-02), ported test-by-test from `apps/workers/src/discovery/windows.ts`.
 *
 * GitHub Search returns at most 1000 results per query, so a keyword is split into star bands,
 * and any band still over 1000 is subdivided by creation date until it fits.
 *
 * Boundaries are calendar-aligned rather than bisected, and that is load-bearing: a resumed
 * sweep matches completed windows by query string, so a window whose bounds shifted with the
 * current date would invalidate every resume. `created:2020-01-01..2020-03-31` means the same
 * thing tomorrow.
 *
 * Pure: no network, no Doctrine, no ambient clock — `$now` is always passed in.
 */
final class Windows
{
    /**
     * Kubernetes launched in 2014; GitHub opened in 2008. Everything older is one bucket.
     *
     * Known, deliberate near-floor, not a hard one — see windows.ts's identical comment: a live
     * probe of `created:<2008-01-01` returns exactly one repo (`mojombo/grit`), knowingly
     * dropped rather than chased.
     */
    public const GITHUB_EPOCH_YEAR = 2008;
    public const EARLY_YEARS_END = 2013;

    /**
     * Coarse at the top where repos are few, fine at the bottom where the long tail lives.
     * Must remain contiguous from 0 upward — WindowsTest asserts it.
     *
     * @var list<string>
     */
    public const STAR_BANDS = [
        '>5000',
        '1000..5000',
        '500..999',
        '200..499',
        '100..199',
        '50..99',
        '20..49',
        '10..19',
        '5..9',
        '3..4',
        '2',
        '1',
        '0',
    ];

    private function __construct()
    {
    }

    /**
     * @return list<Window>
     */
    public static function initial(string $base): array
    {
        return array_map(
            static fn (string $stars): Window => new Window($base, $stars, null),
            self::STAR_BANDS,
        );
    }

    /**
     * Sub-windows one level finer. An empty result means the floor: a single day.
     *
     * `$now` is required, not defaulted — it decides how many yearly windows an unconstrained
     * band expands to, and it must be threaded from a single clock read by the caller, exactly
     * like `windows.ts`'s `split`.
     *
     * @return list<Window>
     */
    public static function split(Window $window, \DateTimeImmutable $now): array
    {
        $currentYear = (int) $now->setTimezone(new \DateTimeZone('UTC'))->format('Y');

        return array_map(
            static fn (Created $created): Window => $window->withCreated($created),
            self::splitCreated($window->created, $currentYear),
        );
    }

    /**
     * @return list<Created>
     */
    private static function splitCreated(?Created $created, int $currentYear): array
    {
        if (null === $created) {
            $out = [Created::years(self::GITHUB_EPOCH_YEAR, self::EARLY_YEARS_END)];
            for ($year = self::EARLY_YEARS_END + 1; $year <= $currentYear; ++$year) {
                $out[] = Created::year($year);
            }

            return $out;
        }

        return match ($created->kind) {
            'years' => self::splitYears($created),
            'year' => self::splitYear($created),
            'quarter' => self::splitQuarter($created),
            'month' => self::splitMonth($created),
            'day' => [],
            default => throw new \LogicException(\sprintf('Unreachable Created.kind "%s".', $created->kind)),
        };
    }

    /**
     * @return list<Created>
     */
    private static function splitYears(Created $created): array
    {
        $out = [];
        for ($year = $created->fromOf(); $year <= $created->toOf(); ++$year) {
            $out[] = Created::year($year);
        }

        return $out;
    }

    /**
     * @return list<Created>
     */
    private static function splitYear(Created $created): array
    {
        return array_map(
            static fn (int $quarter): Created => Created::quarter($created->yearOf(), $quarter),
            [1, 2, 3, 4],
        );
    }

    /**
     * @return list<Created>
     */
    private static function splitQuarter(Created $created): array
    {
        $first = ($created->quarterOf() - 1) * 3 + 1;

        return array_map(
            static fn (int $month): Created => Created::month($created->yearOf(), $month),
            [$first, $first + 1, $first + 2],
        );
    }

    /**
     * Splitting the current month emits days that haven't happened yet — e.g. on the 4th, 27 of
     * the 31 windows are guaranteed-empty future dates. Intentional, not an oversight: clamping
     * to `now` would make the window's query string (and therefore its resume identity) change
     * every day. A few wasted requests against an empty result set is a fair trade for a query
     * string that never moves — same rule as `windows.ts`.
     *
     * @return list<Created>
     */
    private static function splitMonth(Created $created): array
    {
        $out = [];
        $days = self::daysInMonth($created->yearOf(), $created->monthOf());
        for ($day = 1; $day <= $days; ++$day) {
            $out[] = Created::day(self::iso($created->yearOf(), $created->monthOf(), $day));
        }

        return $out;
    }

    /** The GitHub search query this window represents. Doubles as its identity in resume state. */
    public static function queryOf(Window $window): string
    {
        $parts = [$window->base, "stars:{$window->stars}"];
        $range = self::createdRange($window->created);
        if (null !== $range) {
            $parts[] = "created:{$range}";
        }

        return implode(' ', $parts);
    }

    private static function createdRange(?Created $created): ?string
    {
        if (null === $created) {
            return null;
        }

        return match ($created->kind) {
            'years' => \sprintf('%d-01-01..%d-12-31', $created->fromOf(), $created->toOf()),
            'year' => \sprintf('%d-01-01..%d-12-31', $created->yearOf(), $created->yearOf()),
            'quarter' => self::quarterRange($created),
            'month' => \sprintf(
                '%s..%s',
                self::iso($created->yearOf(), $created->monthOf(), 1),
                self::iso($created->yearOf(), $created->monthOf(), self::daysInMonth($created->yearOf(), $created->monthOf())),
            ),
            'day' => $created->dateOf(),
            default => throw new \LogicException(\sprintf('Unreachable Created.kind "%s".', $created->kind)),
        };
    }

    private static function quarterRange(Created $created): string
    {
        $first = ($created->quarterOf() - 1) * 3 + 1;
        $last = $first + 2;

        return \sprintf(
            '%s..%s',
            self::iso($created->yearOf(), $first, 1),
            self::iso($created->yearOf(), $last, self::daysInMonth($created->yearOf(), $last)),
        );
    }

    /** `$month` is 1-indexed. No `ext-calendar` dependency: walks via DateTimeImmutable instead. */
    public static function daysInMonth(int $year, int $month): int
    {
        $firstOfMonth = new \DateTimeImmutable(\sprintf('%04d-%02d-01', $year, $month), new \DateTimeZone('UTC'));

        return (int) $firstOfMonth->modify('first day of next month')->modify('-1 day')->format('j');
    }

    private static function iso(int $year, int $month, int $day): string
    {
        return \sprintf('%04d-%02d-%02d', $year, $month, $day);
    }
}
