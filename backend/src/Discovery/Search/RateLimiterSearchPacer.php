<?php

declare(strict_types=1);

namespace App\Discovery\Search;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\RateLimiter\RateLimiterFactory;

/**
 * The production {@see SearchPacer}: Symfony's `RateLimiter` component, configured in
 * `config/packages/rate_limiter.yaml` as `discovery_search` — its own budget, never shared with
 * the crawler's REST quota (AGENTS.md §4.1).
 */
final class RateLimiterSearchPacer implements SearchPacer
{
    public function __construct(
        #[Autowire(service: 'limiter.discovery_search')]
        private readonly RateLimiterFactory $limiterFactory,
    ) {
    }

    public function pace(): void
    {
        $this->limiterFactory->create()->reserve(1)->wait();
    }
}
