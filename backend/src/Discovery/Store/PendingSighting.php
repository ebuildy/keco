<?php

declare(strict_types=1);

namespace App\Discovery\Store;

use App\Discovery\Search\SearchItem;

/** One recorded-but-not-yet-flushed repo sighting, buffered by {@see DiscoveryStore::record()}. */
final readonly class PendingSighting
{
    public function __construct(
        public string $id,
        public SearchItem $item,
        public string $payloadHash,
        public string $firstSeenRunId,
        public bool $isNew,
        public string $discoveredVia,
        public \DateTimeImmutable $discoveredAt,
    ) {
    }
}
