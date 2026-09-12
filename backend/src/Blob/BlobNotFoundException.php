<?php

declare(strict_types=1);

namespace App\Blob;

final class BlobNotFoundException extends \RuntimeException
{
    public static function forKey(string $key): self
    {
        return new self(sprintf('Blob "%s" not found.', $key));
    }
}
