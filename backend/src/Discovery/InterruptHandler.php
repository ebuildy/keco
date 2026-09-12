<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * Graceful shutdown for the sweep loop, ported from `apps/workers/src/lib/shutdown.ts`'s
 * `createShutdown` — a worker that runs for hours will be interrupted, and that is normal
 * operation, not an incident (AGENTS.md §4).
 *
 * `pcntl` is optional in PHP builds (absent on some platforms, and always absent under
 * non-CLI SAPIs); `install()` is a deliberate no-op when it isn't loaded rather than an error,
 * because "safe to kill at any moment" already holds without a handler — a SIGKILL bypasses any
 * handler anyway, and that is the documented, deliberate `running`-forever behavior (AGENTS.md
 * §4.1). A trapped SIGINT/SIGTERM only makes the common case (a clean Ctrl-C) tidier.
 */
final class InterruptHandler
{
    private function __construct()
    {
    }

    /**
     * @param callable(int): void $onInterrupt Must not throw — flushing durable state before
     *                                          the process exits, never anything that can fail
     *                                          loudly mid-shutdown.
     */
    public static function install(callable $onInterrupt): void
    {
        if (!\function_exists('pcntl_async_signals') || !\function_exists('pcntl_signal')) {
            return;
        }

        pcntl_async_signals(true);

        $handler = static function (int $signal) use ($onInterrupt): void {
            $onInterrupt($signal);
            exit(self::exitCodeFor($signal));
        };

        pcntl_signal(\SIGINT, $handler);
        pcntl_signal(\SIGTERM, $handler);
    }

    /** 128 + signal number, the shell convention — matches `shutdown.ts`'s `EXIT_CODES`. */
    private static function exitCodeFor(int $signal): int
    {
        return match ($signal) {
            \SIGINT => 130,
            \SIGTERM => 143,
            default => 128 + $signal,
        };
    }
}
