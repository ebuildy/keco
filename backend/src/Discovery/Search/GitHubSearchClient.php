<?php

declare(strict_types=1);

namespace App\Discovery\Search;

use App\Discovery\Clock;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\HttpClient\Exception\TransportExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * GitHub Search for the discovery context (design 2026-08-02, ported from `packages/github/src/search.ts`).
 *
 * Search has its own budget — roughly 30 requests/minute authenticated — separate from the
 * 5000 points/hour REST budget the crawler and analyzer share (AGENTS.md §4.1, §4.2). So this
 * client paces itself via {@see SearchPacer} and never touches the crawler's quota.
 */
final class GitHubSearchClient
{
    private const ENDPOINT = 'https://api.github.com/search/repositories';

    /** GitHub Search never returns more than this, however many pages you ask for. */
    private const MAX_RESULTS_PER_QUERY = 1000;

    /**
     * GitHub documents at least a 60s wait for a *secondary* rate limit, signalled by a bare 403
     * with no `retry-after` at all. Retrying sooner is how a soft limit becomes a block.
     */
    private const THROTTLE_FLOOR_MS = 60_000;

    /** A bogus `retry-after: 3600` (or a stale ratelimit-reset) must not sleep a silent hour. */
    private const THROTTLE_CEILING_MS = 300_000;

    /** 403/429 mean "slow down"; these mean "the server had a bad moment, try again." */
    private const TRANSIENT_STATUSES = [408, 500, 502, 503, 504];

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        private readonly SearchPacer $pacer,
        private readonly Clock $clock,
        #[Autowire(env: 'GITHUB_TOKEN')]
        private readonly string $token,
        private readonly int $maxRetries = 5,
        private readonly int $timeoutSeconds = 30,
    ) {
    }

    /**
     * Fetches one page of a search query, paced and retried, returning only the items that
     * validated. `$page`/`$perPage` are rejected up front when they would land outside GitHub
     * Search's 1000-result cap — that call would 422 anyway, after spending a rate slot.
     */
    public function page(string $query, int $page, int $perPage = 100): SearchPage
    {
        if ($perPage > 100) {
            throw new \InvalidArgumentException(\sprintf('perPage must be <= 100 (GitHub search\'s own cap), got %d', $perPage));
        }
        if ($page * $perPage > self::MAX_RESULTS_PER_QUERY) {
            throw new \InvalidArgumentException(\sprintf(
                'page %d at perPage %d would exceed GitHub search\'s %d-result cap',
                $page,
                $perPage,
                self::MAX_RESULTS_PER_QUERY,
            ));
        }

        for ($attempt = 0; ; ++$attempt) {
            $this->pacer->pace();

            try {
                $response = $this->httpClient->request('GET', self::ENDPOINT, [
                    'query' => ['q' => $query, 'per_page' => $perPage, 'page' => $page],
                    'headers' => [
                        'Authorization' => 'Bearer '.$this->token,
                        'Accept' => 'application/vnd.github+json',
                        'User-Agent' => 'keco',
                        'X-GitHub-Api-Version' => '2022-11-28',
                    ],
                    'timeout' => $this->timeoutSeconds,
                ]);
                $status = $response->getStatusCode();
            } catch (TransportExceptionInterface $e) {
                if ($attempt >= $this->maxRetries) {
                    throw new GitHubSearchException('github search: transport failure, out of retries', previous: $e);
                }
                $this->clock->sleep(self::backoffMs($attempt));
                continue;
            }

            if (200 === $status) {
                /** @var array<array-key, mixed> $data */
                $data = $response->toArray(false);

                return $this->parsePage($data);
            }

            if (403 === $status || 429 === $status) {
                if ($attempt >= $this->maxRetries) {
                    throw new GitHubSearchException(\sprintf('github search throttled (status %d), out of retries', $status));
                }
                $this->clock->sleep($this->throttleWaitMs($response->getHeaders(false)));
                continue;
            }

            if (\in_array($status, self::TRANSIENT_STATUSES, true)) {
                if ($attempt >= $this->maxRetries) {
                    throw new GitHubSearchException(\sprintf('github search failed (status %d), out of retries', $status));
                }
                $this->clock->sleep(self::backoffMs($attempt));
                continue;
            }

            throw new GitHubSearchException(\sprintf('github search failed with unexpected status %d', $status));
        }
    }

    /**
     * @param array<string, list<string>> $headers
     */
    private function throttleWaitMs(array $headers): int
    {
        $retryAfter = (int) ($headers['retry-after'][0] ?? 0);
        if ($retryAfter > 0) {
            return min(self::THROTTLE_CEILING_MS, $retryAfter * 1000);
        }

        $reset = (int) ($headers['x-ratelimit-reset'][0] ?? 0);
        if ($reset > 0) {
            $delay = $reset * 1000 - $this->clock->now();
            if ($delay > 0) {
                return min(self::THROTTLE_CEILING_MS, $delay);
            }
        }

        return self::THROTTLE_FLOOR_MS;
    }

    /**
     * @param array<array-key, mixed> $data
     */
    private function parsePage(array $data): SearchPage
    {
        $totalCount = $data['total_count'] ?? null;
        $incomplete = $data['incomplete_results'] ?? null;
        $items = $data['items'] ?? null;

        if (!\is_int($totalCount) || !\is_bool($incomplete) || !\is_array($items)) {
            throw new GitHubSearchException('github search: page envelope failed validation');
        }

        $parsed = [];
        $dropped = 0;
        foreach ($items as $candidate) {
            if (!\is_array($candidate)) {
                ++$dropped;
                continue;
            }
            try {
                $parsed[] = SearchItem::fromArray($candidate);
            } catch (InvalidSearchItemException) {
                ++$dropped;
            }
        }

        // A page where every item failed to parse is not "one bad repo" — it's GitHub having
        // changed shape corpus-wide. An empty-but-successful page would let the caller mark the
        // window complete and the sweep "succeed" with the data silently missing.
        if ($dropped > 0 && $dropped === \count($items)) {
            throw new GitHubSearchException(\sprintf(
                'github search: all %d items on this page failed to parse — treating as a schema change, not per-repo noise',
                $dropped,
            ));
        }

        return new SearchPage($totalCount, $incomplete, $parsed, $dropped);
    }

    /** Exponential backoff for transient transport/5xx errors; throttle waits are computed separately. */
    private static function backoffMs(int $attempt): int
    {
        return min(60_000, 2 ** $attempt * 1000) + random_int(0, 250);
    }
}
