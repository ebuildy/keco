<?php

declare(strict_types=1);

namespace App\Discovery\Search;

/**
 * Discovery's own rate pacer, separate from the crawler's REST budget (AGENTS.md §4.1: GitHub
 * Search is limited far more tightly — ~30 req/min authenticated — than the 5000 points/hour
 * core REST budget the crawler and analyzer share, and mixing the two stalls both).
 *
 * One method, called before every request: `pace()` blocks until the next request is allowed.
 * The production implementation ({@see RateLimiterSearchPacer}) is built on Symfony's
 * `RateLimiter` component; tests use a fake that never blocks, so the retry/backoff logic in
 * {@see GitHubSearchClient} is testable without a real clock.
 */
interface SearchPacer
{
    public function pace(): void;
}
