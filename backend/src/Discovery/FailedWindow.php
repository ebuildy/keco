<?php

declare(strict_types=1);

namespace App\Discovery;

/** One window that failed during a sweep, and why. Ported from `collections.ts`'s `FailedWindow`. */
final readonly class FailedWindow
{
    public function __construct(
        public string $window,
        public string $error,
    ) {
    }

    /**
     * @return array{window: string, error: string}
     */
    public function toArray(): array
    {
        return ['window' => $this->window, 'error' => $this->error];
    }

    /**
     * @param array<array-key, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $window = $data['window'] ?? null;
        $error = $data['error'] ?? null;
        if (!\is_string($window) || !\is_string($error)) {
            throw new \InvalidArgumentException('FailedWindow.window and FailedWindow.error must be strings.');
        }

        return new self($window, $error);
    }
}
