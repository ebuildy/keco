<?php

declare(strict_types=1);

namespace App\Taxonomy;

/**
 * Every failure mode — missing file, YAML syntax, shape, cross-family invariant — throws this
 * with a message starting `taxonomy: ` that reads as prose (mirrors
 * packages/core/src/taxonomy-schema.ts's `fail()`). A taxonomy that fails to load takes every
 * worker and the web app down (AGENTS.md §6), so the message must be enough to fix the file
 * without a debugger.
 */
final class TaxonomyValidationException extends \RuntimeException
{
    public static function because(string $message): self
    {
        return new self("taxonomy: {$message}");
    }
}
