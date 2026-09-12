<?php

declare(strict_types=1);

namespace App\Discovery\Search;

/** One GitHub Search result failed structural validation. Never fatal on its own — see {@see GitHubSearchClient}. */
final class InvalidSearchItemException extends \RuntimeException
{
    public static function forField(string $field): self
    {
        return new self(\sprintf('search item failed validation: field "%s"', $field));
    }
}
