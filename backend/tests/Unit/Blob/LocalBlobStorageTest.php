<?php

declare(strict_types=1);

namespace App\Tests\Unit\Blob;

use App\Blob\BlobNotFoundException;
use App\Blob\LocalBlobStorage;
use League\Flysystem\Filesystem;
use League\Flysystem\Local\LocalFilesystemAdapter;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Filesystem\Filesystem as SymfonyFilesystem;

/**
 * The blob store is what §3.1 keeps once structured data has a real home in Postgres: verbatim
 * bytes in, verbatim bytes out, addressed by a string key. No parsing, no transformation.
 */
final class LocalBlobStorageTest extends TestCase
{
    private string $root;
    private LocalBlobStorage $storage;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir().'/keco-blob-test-'.bin2hex(random_bytes(8));
        $operator = new Filesystem(new LocalFilesystemAdapter($this->root));
        $this->storage = new LocalBlobStorage($operator);
    }

    protected function tearDown(): void
    {
        (new SymfonyFilesystem())->remove($this->root);
    }

    public function testPutThenGetReturnsTheExactBytes(): void
    {
        $bytes = "# README\n\nSome \x00 binary-ish content \xFF here.";

        $this->storage->put('repos/kubernetes/kubectl/readme.md', $bytes);

        self::assertSame($bytes, $this->storage->get('repos/kubernetes/kubectl/readme.md'));
    }

    public function testExistsIsFalseForAMissingKey(): void
    {
        self::assertFalse($this->storage->exists('repos/does/not/exist.json'));
    }

    public function testExistsIsTrueAfterAPut(): void
    {
        $this->storage->put('repos/a/a/icon.src', 'binary');

        self::assertTrue($this->storage->exists('repos/a/a/icon.src'));
    }

    public function testGetOnAMissingKeyThrows(): void
    {
        $this->expectException(BlobNotFoundException::class);

        $this->storage->get('nope');
    }

    public function testPutOverwritesAnExistingKey(): void
    {
        $this->storage->put('k', 'first');
        $this->storage->put('k', 'second');

        self::assertSame('second', $this->storage->get('k'));
    }
}
