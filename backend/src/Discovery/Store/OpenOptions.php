<?php

declare(strict_types=1);

namespace App\Discovery\Store;

use Symfony\Component\Uid\Ulid;

/** Options for {@see DiscoveryStore::open()}, mirroring `store.ts`'s `OpenOptions`. */
final class OpenOptions
{
    public function __construct(
        public bool $fresh = false,
        public ?\DateTimeImmutable $now = null,
        /** Injected so tests are deterministic; defaults to a fresh Ulid. */
        public ?Ulid $runId = null,
        /** Recorded on the run entity so history explains a short sweep. */
        public ?int $limit = null,
    ) {
    }
}
