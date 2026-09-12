<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * A GitHub Search window: a keyword narrowed by a star band and, once split, a creation-date
 * range (design 2026-08-02, ported from `windows.ts`'s `Window` type). Immutable.
 */
final readonly class Window
{
    public function __construct(
        public string $base,
        public string $stars,
        public ?Created $created,
    ) {
    }

    public function withCreated(?Created $created): self
    {
        return new self($this->base, $this->stars, $created);
    }

    /**
     * @return array{base: string, stars: string, created: array<string, int|string>|null}
     */
    public function toArray(): array
    {
        return [
            'base' => $this->base,
            'stars' => $this->stars,
            'created' => $this->created?->toArray(),
        ];
    }

    /**
     * @param array<array-key, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $base = $data['base'] ?? null;
        $stars = $data['stars'] ?? null;
        if (!\is_string($base) || !\is_string($stars)) {
            throw new \InvalidArgumentException('Window.base and Window.stars must be strings.');
        }

        $createdData = $data['created'] ?? null;

        return new self($base, $stars, \is_array($createdData) ? Created::fromArray($createdData) : null);
    }
}
