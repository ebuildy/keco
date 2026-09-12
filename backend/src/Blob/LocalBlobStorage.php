<?php

declare(strict_types=1);

namespace App\Blob;

use League\Flysystem\FilesystemException;
use League\Flysystem\FilesystemOperator;
use League\Flysystem\UnableToReadFile;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\DependencyInjection\Attribute\AsAlias;

/**
 * Today's only {@see BlobStorageInterface} adapter: Flysystem's local filesystem driver,
 * configured in config/packages/flysystem.yaml as `blob.storage`. Swapping to S3 later means
 * adding an adapter here and changing that one config block — no caller touched (AGENTS.md §3).
 */
#[AsAlias(BlobStorageInterface::class)]
final class LocalBlobStorage implements BlobStorageInterface
{
    public function __construct(
        #[Autowire(service: 'blob.storage')]
        private readonly FilesystemOperator $storage,
    ) {
    }

    public function put(string $key, string $contents): void
    {
        try {
            $this->storage->write($key, $contents);
        } catch (FilesystemException $e) {
            throw new \RuntimeException(sprintf('Could not write blob "%s".', $key), previous: $e);
        }
    }

    public function get(string $key): string
    {
        try {
            return $this->storage->read($key);
        } catch (UnableToReadFile $e) {
            throw BlobNotFoundException::forKey($key);
        } catch (FilesystemException $e) {
            throw new \RuntimeException(sprintf('Could not read blob "%s".', $key), previous: $e);
        }
    }

    public function exists(string $key): bool
    {
        try {
            return $this->storage->fileExists($key);
        } catch (FilesystemException $e) {
            throw new \RuntimeException(sprintf('Could not check blob "%s".', $key), previous: $e);
        }
    }
}
