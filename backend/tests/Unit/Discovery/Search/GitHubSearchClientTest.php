<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery\Search;

use App\Discovery\Search\GitHubSearchClient;
use App\Discovery\Search\GitHubSearchException;
use App\Tests\Unit\Discovery\FakeClock;
use PHPUnit\Framework\TestCase;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

/**
 * Ported in spirit from `packages/github/src/search.test.ts` — pacing, retry/backoff and
 * page-envelope validation, all against a mocked transport so nothing here touches the network
 * or a real clock.
 */
final class GitHubSearchClientTest extends TestCase
{
    /**
     * @return array<string, mixed>
     */
    private static function page(int $totalCount = 1, bool $incomplete = false): array
    {
        return [
            'total_count' => $totalCount,
            'incomplete_results' => $incomplete,
            'items' => [self::item()],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function item(int $id = 1): array
    {
        return [
            'id' => $id,
            'full_name' => 'kubernetes/kubectl',
            'name' => 'kubectl',
            'owner' => ['login' => 'kubernetes'],
            'description' => null,
            'homepage' => null,
            'stargazers_count' => 100,
            'forks_count' => 10,
            'open_issues_count' => 2,
            'language' => 'Go',
            'license' => null,
            'topics' => [],
            'archived' => false,
            'fork' => false,
            'default_branch' => 'main',
            'created_at' => '2020-01-01T00:00:00Z',
            'updated_at' => '2026-01-01T00:00:00Z',
            'pushed_at' => null,
        ];
    }

    /**
     * @param array<string, mixed> $data
     */
    private static function json(array $data): string
    {
        return json_encode($data, \JSON_THROW_ON_ERROR);
    }

    private function client(MockHttpClient $http, ?NullSearchPacer $pacer = null, ?FakeClock $clock = null, int $maxRetries = 5): GitHubSearchClient
    {
        return new GitHubSearchClient(
            $http,
            $pacer ?? new NullSearchPacer(),
            $clock ?? new FakeClock(),
            'test-token',
            $maxRetries,
        );
    }

    public function testRejectsAPageThatWouldExceedThe1000ResultCap(): void
    {
        $client = $this->client(new MockHttpClient());

        $this->expectException(\InvalidArgumentException::class);
        $client->page('kubernetes', 11, 100);
    }

    public function testRejectsAPerPageOverGitHubsOwnCap(): void
    {
        $client = $this->client(new MockHttpClient());

        $this->expectException(\InvalidArgumentException::class);
        $client->page('kubernetes', 1, 101);
    }

    public function testPacesBeforeEveryRequest(): void
    {
        $pacer = new NullSearchPacer();
        $http = new MockHttpClient([new MockResponse(self::json(self::page()), ['http_code' => 200])]);

        $this->client($http, $pacer)->page('kubernetes', 1);

        self::assertSame(1, $pacer->calls);
    }

    public function testParsesASuccessfulPage(): void
    {
        $http = new MockHttpClient([new MockResponse(self::json(self::page(totalCount: 42)), ['http_code' => 200])]);

        $result = $this->client($http)->page('kubernetes', 1);

        self::assertSame(42, $result->totalCount);
        self::assertFalse($result->incompleteResults);
        self::assertCount(1, $result->items);
        self::assertSame(0, $result->dropped);
        self::assertSame('kubernetes/kubectl', $result->items[0]->fullName);
    }

    public function testDropsAMalformedItemWithoutFailingThePage(): void
    {
        $body = [
            'total_count' => 2,
            'incomplete_results' => false,
            'items' => [self::item(), ['id' => 'not-a-repo']],
        ];
        $http = new MockHttpClient([new MockResponse(self::json($body), ['http_code' => 200])]);

        $result = $this->client($http)->page('kubernetes', 1);

        self::assertCount(1, $result->items);
        self::assertSame(1, $result->dropped);
    }

    public function testFailsThePageWhenEveryItemIsMalformed(): void
    {
        $body = ['total_count' => 1, 'incomplete_results' => false, 'items' => [['id' => 'bogus']]];
        $http = new MockHttpClient([new MockResponse(self::json($body), ['http_code' => 200])]);

        $this->expectException(GitHubSearchException::class);
        $this->client($http)->page('kubernetes', 1);
    }

    public function testRetriesA503AndThenSucceeds(): void
    {
        $clock = new FakeClock();
        $http = new MockHttpClient([
            new MockResponse('', ['http_code' => 503]),
            new MockResponse(self::json(self::page()), ['http_code' => 200]),
        ]);

        $result = $this->client($http, clock: $clock)->page('kubernetes', 1);

        self::assertSame(1, $result->totalCount);
        self::assertCount(1, $clock->slept);
    }

    public function testGivesUpAfterMaxRetriesOnRepeated503s(): void
    {
        $responses = array_fill(0, 3, new MockResponse('', ['http_code' => 503]));
        $http = new MockHttpClient($responses);

        $this->expectException(GitHubSearchException::class);
        $this->client($http, clock: new FakeClock(), maxRetries: 2)->page('kubernetes', 1);
    }

    public function testHonoursRetryAfterOnA403Throttle(): void
    {
        $clock = new FakeClock();
        $http = new MockHttpClient([
            new MockResponse('', ['http_code' => 403, 'response_headers' => ['retry-after' => '5']]),
            new MockResponse(self::json(self::page()), ['http_code' => 200]),
        ]);

        $this->client($http, clock: $clock)->page('kubernetes', 1);

        self::assertSame([5000], $clock->slept);
    }

    public function testFallsBackToTheThrottleFloorWithNoUsableHeader(): void
    {
        $clock = new FakeClock();
        $http = new MockHttpClient([
            new MockResponse('', ['http_code' => 429]),
            new MockResponse(self::json(self::page()), ['http_code' => 200]),
        ]);

        $this->client($http, clock: $clock)->page('kubernetes', 1);

        self::assertSame([60_000], $clock->slept);
    }

    public function testCapsAnAbsurdRetryAfterAtTheThrottleCeiling(): void
    {
        $clock = new FakeClock();
        $http = new MockHttpClient([
            new MockResponse('', ['http_code' => 403, 'response_headers' => ['retry-after' => '3600']]),
            new MockResponse(self::json(self::page()), ['http_code' => 200]),
        ]);

        $this->client($http, clock: $clock)->page('kubernetes', 1);

        self::assertSame([300_000], $clock->slept);
    }

    public function testThrowsOnAnUnrecoverableStatus(): void
    {
        $http = new MockHttpClient([new MockResponse('', ['http_code' => 422])]);

        $this->expectException(GitHubSearchException::class);
        $this->client($http)->page('kubernetes', 1);
    }
}
