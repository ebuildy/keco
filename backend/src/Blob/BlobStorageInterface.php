<?php

declare(strict_types=1);

namespace App\Blob;

/**
 * The direct descendant of the old `Storage` port (AGENTS.md §3.1): what doesn't belong in a
 * jsonb column — README markdown, icon bytes, derived PNGs. One port, a swappable adapter
 * (local today, S3 later), verbatim bytes in and out. No parsing, no transformation here.
 */
interface BlobStorageInterface
{
    /**
     * Writes `$contents` verbatim under `$key`, overwriting any existing value.
     */
    public function put(string $key, string $contents): void;

    /**
     * Reads the exact bytes stored under `$key`.
     *
     * @throws BlobNotFoundException if `$key` does not exist
     */
    public function get(string $key): string;

    public function exists(string $key): bool;
}
