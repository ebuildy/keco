<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery;

use App\Discovery\DiscoverySweepRunner;
use App\Discovery\Search\GitHubSearchClient;
use App\Discovery\SystemClock;
use App\Discovery\Windows;
use App\Repository\DiscoveryRepoRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoveryStateRepository;
use App\Tests\Unit\Discovery\Search\NullSearchPacer;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\NullLogger;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\MockResponse;

/**
 * End-to-end over the pure algebra + DiscoveryStore + a mocked GitHub Search transport — the
 * closest PHP equivalent to exercising `apps/workers/src/discovery/index.ts`'s `runDiscovery`
 * without a live network call.
 */
final class DiscoverySweepRunnerTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private DiscoveryRepoRepository $repos;
    private DiscoveryRunRepository $runs;
    private DiscoveryStateRepository $states;

    protected function setUp(): void
    {
        self::bootKernel();
        $container = static::getContainer();

        $this->em = $container->get(EntityManagerInterface::class);
        $this->repos = $container->get(DiscoveryRepoRepository::class);
        $this->runs = $container->get(DiscoveryRunRepository::class);
        $this->states = $container->get(DiscoveryStateRepository::class);

        $this->em->getConnection()->executeStatement('TRUNCATE TABLE discovery_repos, discovery_runs, discovery_state');
    }

    /**
     * @return array<string, mixed>
     */
    private static function item(int $id): array
    {
        return [
            'id' => $id,
            'full_name' => "org/repo-{$id}",
            'name' => "repo-{$id}",
            'owner' => ['login' => 'org'],
            'description' => null,
            'homepage' => null,
            'stargazers_count' => $id,
            'forks_count' => 0,
            'open_issues_count' => 0,
            'language' => 'Go',
            'license' => null,
            'topics' => [],
            'archived' => false,
            'fork' => false,
            'default_branch' => 'main',
            'created_at' => '2020-01-01T00:00:00Z',
            'updated_at' => '2020-01-01T00:00:00Z',
            'pushed_at' => null,
        ];
    }

    /**
     * One canned page per star band: `initialWindows()` starts with `count(STAR_BANDS)`
     * unconstrained windows, and every one here fits under the 1000-result cap on its first
     * probe, so the sweep never splits or paginates — exactly `count(STAR_BANDS)` requests.
     */
    private static function onePageResponsePerBand(): MockHttpClient
    {
        $responses = [];
        foreach (Windows::STAR_BANDS as $i => $band) {
            $body = [
                'total_count' => 1,
                'incomplete_results' => false,
                'items' => [self::item($i + 1)],
            ];
            $responses[] = new MockResponse(json_encode($body, \JSON_THROW_ON_ERROR), ['http_code' => 200]);
        }

        return new MockHttpClient($responses);
    }

    private function runner(MockHttpClient $http): DiscoverySweepRunner
    {
        $search = new GitHubSearchClient($http, new NullSearchPacer(), new SystemClock(), 'test-token');

        return new DiscoverySweepRunner($this->em, $this->repos, $this->runs, $this->states, $search, new SystemClock(), new NullLogger());
    }

    public function testSweepsEveryStarBandAndRecordsOneRepoPerBand(): void
    {
        $runner = $this->runner(self::onePageResponsePerBand());

        $result = $runner->run('kubernetes', limit: null, fresh: false, now: new \DateTimeImmutable('2026-08-02T00:00:00Z'));

        self::assertTrue($result->success);
        self::assertSame(\count(Windows::STAR_BANDS), $result->reposTotal);
        self::assertSame(\count(Windows::STAR_BANDS), $result->windowsCompleted);
        self::assertSame(0, $result->windowsFailed);
        self::assertSame(\count(Windows::STAR_BANDS), $this->repos->countByQuerySlug('kubernetes'));

        $run = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($run);
        self::assertSame('complete', $run->getOutcome());
    }

    public function testAWindowThatFailsIsRecordedAndTheSweepStillFinishes(): void
    {
        // The first request throws (simulating an unrecoverable transport failure after
        // retries); every other band still succeeds.
        $responses = [new MockResponse('', ['http_code' => 422])];
        foreach (\array_slice(Windows::STAR_BANDS, 1) as $i => $band) {
            $body = ['total_count' => 1, 'incomplete_results' => false, 'items' => [self::item($i + 100)]];
            $responses[] = new MockResponse(json_encode($body, \JSON_THROW_ON_ERROR), ['http_code' => 200]);
        }
        $runner = $this->runner(new MockHttpClient($responses));

        $result = $runner->run('kubernetes', limit: null, fresh: false, now: new \DateTimeImmutable('2026-08-02T00:00:00Z'));

        self::assertFalse($result->success);
        self::assertSame(1, $result->windowsFailed);
        self::assertSame(\count(Windows::STAR_BANDS) - 1, $result->windowsCompleted);

        $run = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($run);
        self::assertSame('failed', $run->getOutcome());
    }

    public function testLimitStopsTheSweepAtTheFirstWindowBoundaryPastN(): void
    {
        $runner = $this->runner(self::onePageResponsePerBand());

        $result = $runner->run('kubernetes', limit: 2, fresh: false, now: new \DateTimeImmutable('2026-08-02T00:00:00Z'));

        self::assertTrue($result->stoppedAtLimit);
        // Overshoots to the window boundary past the limit, per AGENTS.md §4.1 — never fewer
        // than the limit, and it does not need to be exactly the limit either.
        self::assertGreaterThanOrEqual(2, $result->reposTotal);
        self::assertLessThan(\count(Windows::STAR_BANDS), $result->reposTotal);
    }

    public function testFreshStartsOverEvenAfterAPreviousCompleteSweep(): void
    {
        $first = $this->runner(self::onePageResponsePerBand());
        $first->run('kubernetes', limit: null, fresh: false, now: new \DateTimeImmutable('2026-08-02T00:00:00Z'));

        $second = $this->runner(self::onePageResponsePerBand());
        $result = $second->run('kubernetes', limit: null, fresh: true, now: new \DateTimeImmutable('2026-08-09T00:00:00Z'));

        self::assertFalse($result->resuming);
        self::assertTrue($result->success);
        self::assertSame(\count(Windows::STAR_BANDS), $this->repos->countByQuerySlug('kubernetes'));
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        unset($this->em, $this->repos, $this->runs, $this->states);
    }
}
