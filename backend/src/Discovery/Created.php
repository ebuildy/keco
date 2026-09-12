<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * One node of the calendar-splitting tree (design 2026-08-02, ported from
 * `apps/workers/src/discovery/windows.ts`'s `Created` discriminated union).
 *
 * PHP has no discriminated union, so this is one immutable class with named constructors
 * standing in for the five TS variants (`years`, `year`, `quarter`, `month`, `day`) and a
 * `kind` discriminator read by {@see Windows} and {@see Plan}.
 */
final readonly class Created
{
    private function __construct(
        public string $kind,
        public ?int $from = null,
        public ?int $to = null,
        public ?int $year = null,
        public ?int $quarter = null,
        public ?int $month = null,
        public ?string $date = null,
    ) {
    }

    public static function years(int $from, int $to): self
    {
        return new self('years', from: $from, to: $to);
    }

    public static function year(int $year): self
    {
        return new self('year', year: $year);
    }

    public static function quarter(int $year, int $quarter): self
    {
        return new self('quarter', year: $year, quarter: $quarter);
    }

    public static function month(int $year, int $month): self
    {
        return new self('month', year: $year, month: $month);
    }

    public static function day(string $date): self
    {
        return new self('day', date: $date);
    }

    public function yearOf(): int
    {
        return $this->requireInt($this->year, 'year');
    }

    public function fromOf(): int
    {
        return $this->requireInt($this->from, 'from');
    }

    public function toOf(): int
    {
        return $this->requireInt($this->to, 'to');
    }

    public function quarterOf(): int
    {
        return $this->requireInt($this->quarter, 'quarter');
    }

    public function monthOf(): int
    {
        return $this->requireInt($this->month, 'month');
    }

    public function dateOf(): string
    {
        if (null === $this->date) {
            throw new \LogicException(\sprintf('Created(kind: %s) has no "date".', $this->kind));
        }

        return $this->date;
    }

    private function requireInt(?int $value, string $property): int
    {
        if (null === $value) {
            throw new \LogicException(\sprintf('Created(kind: %s) has no "%s".', $this->kind, $property));
        }

        return $value;
    }

    public function equals(self $other): bool
    {
        return $this->kind === $other->kind
            && $this->from === $other->from
            && $this->to === $other->to
            && $this->year === $other->year
            && $this->quarter === $other->quarter
            && $this->month === $other->month
            && $this->date === $other->date;
    }

    /**
     * @return array<string, int|string>
     */
    public function toArray(): array
    {
        $out = ['kind' => $this->kind];
        if (null !== $this->from) {
            $out['from'] = $this->from;
        }
        if (null !== $this->to) {
            $out['to'] = $this->to;
        }
        if (null !== $this->year) {
            $out['year'] = $this->year;
        }
        if (null !== $this->quarter) {
            $out['quarter'] = $this->quarter;
        }
        if (null !== $this->month) {
            $out['month'] = $this->month;
        }
        if (null !== $this->date) {
            $out['date'] = $this->date;
        }

        return $out;
    }

    /**
     * @param array<array-key, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $kind = $data['kind'] ?? null;

        return match ($kind) {
            'years' => self::years(self::intOf($data, 'from'), self::intOf($data, 'to')),
            'year' => self::year(self::intOf($data, 'year')),
            'quarter' => self::quarter(self::intOf($data, 'year'), self::intOf($data, 'quarter')),
            'month' => self::month(self::intOf($data, 'year'), self::intOf($data, 'month')),
            'day' => self::day(self::stringOf($data, 'date')),
            default => throw new \InvalidArgumentException(\sprintf(
                'Unknown Created "kind" %s.',
                \is_string($kind) ? \sprintf('"%s"', $kind) : \gettype($kind),
            )),
        };
    }

    /**
     * @param array<array-key, mixed> $data
     */
    private static function intOf(array $data, string $key): int
    {
        $value = $data[$key] ?? null;
        if (!\is_int($value)) {
            throw new \InvalidArgumentException(\sprintf('Created.%s must be an int.', $key));
        }

        return $value;
    }

    /**
     * @param array<array-key, mixed> $data
     */
    private static function stringOf(array $data, string $key): string
    {
        $value = $data[$key] ?? null;
        if (!\is_string($value)) {
            throw new \InvalidArgumentException(\sprintf('Created.%s must be a string.', $key));
        }

        return $value;
    }
}
