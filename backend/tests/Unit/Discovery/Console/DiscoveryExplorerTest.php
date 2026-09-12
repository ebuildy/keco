<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery\Console;

use App\Discovery\Console\DiscoveryExplorer;
use App\Discovery\Store\DiscoveryStore;
use App\Discovery\Store\OpenOptions;
use App\Discovery\Search\SearchItem;
use App\Discovery\SystemClock;
use App\Repository\DiscoveryRepoRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoveryStateRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

/**
 * Ported in spirit from `explore.test.ts` — seeds real Postgres via `DiscoveryStore` (rather
 * than `InMemoryDataStore`, since there is no PHP equivalent) and exercises the same
 * count/list/reset behaviors.
 */
final class DiscoveryExplorerTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private DiscoveryExplorer $explorer;
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
        $this->explorer = $container->get(DiscoveryExplorer::class);

        $this->em->getConnection()->executeStatement('TRUNCATE TABLE discovery_repos, discovery_runs, discovery_state');
    }

    /**
     * @param array<string, mixed> $overrides
     */
    private static function item(array $overrides): SearchItem
    {
        return SearchItem::fromArray(array_merge([
            'id' => 1,
            'full_name' => 'a/one',
            'name' => 'one',
            'owner' => ['login' => 'a'],
            'description' => null,
            'homepage' => null,
            'stargazers_count' => 10,
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
        ], $overrides));
    }

    private function seed(): void
    {
        $now = new \DateTimeImmutable('2026-08-02T00:00:00Z');

        $k8s = DiscoveryStore::open($this->em, $this->repos, $this->runs, $this->states, new SystemClock(), 'kubernetes', new OpenOptions(now: $now));
        $k8s->record(self::item(['id' => 1, 'full_name' => 'a/one', 'stargazers_count' => 10]), 'q', $now);
        $k8s->record(self::item(['id' => 2, 'full_name' => 'a/two', 'stargazers_count' => 30]), 'q', $now);
        $k8s->flush();
        $k8s->finishRun('complete');

        $istio = DiscoveryStore::open($this->em, $this->repos, $this->runs, $this->states, new SystemClock(), 'istio', new OpenOptions(now: $now));
        $istio->record(self::item(['id' => 3, 'full_name' => 'b/three', 'stargazers_count' => 5]), 'q', $now);
        $istio->flush();
        $istio->finishRun('complete');
    }

    public function testCountReportsOneRowPerQueryOrderedBySlug(): void
    {
        $this->seed();

        $rows = $this->explorer->count(null);

        self::assertSame(['istio', 'kubernetes'], array_map(static fn ($r) => $r->querySlug, $rows));
        $k8s = $rows[1];
        self::assertSame(2, $k8s->repos);
        self::assertSame(1, $k8s->runs);
        self::assertNotNull($k8s->lastRun);
        self::assertSame('complete', $k8s->lastRun->getOutcome());
    }

    public function testCountNarrowsToOneQuery(): void
    {
        $this->seed();

        $rows = $this->explorer->count('istio');

        self::assertCount(1, $rows);
        self::assertSame('istio', $rows[0]->querySlug);
        self::assertSame(1, $rows[0]->repos);
    }

    public function testCountOnAnUnsweptQueryReturnsEmptyRatherThanThrowing(): void
    {
        self::assertSame([], $this->explorer->count('never-swept'));
    }

    public function testResolveSortRejectsAnUndeclaredField(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/nonsense/');
        $this->explorer->resolveSort('runs', 'nonsense');
    }

    public function testResolveSortRejectsABadDirection(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->explorer->resolveSort('runs', 'startedAt:sideways');
    }

    public function testListReposReturnsMostStarredFirstByDefault(): void
    {
        $this->seed();

        $result = $this->explorer->listRepos(null, 10, null);

        self::assertSame(['a/two', 'a/one', 'b/three'], array_map(static fn ($r) => $r->getFullName(), $result->rows));
        self::assertSame(3, $result->total);
    }

    public function testListReposCapsAtTheLimitButReportsTheTrueTotal(): void
    {
        $this->seed();

        $result = $this->explorer->listRepos('kubernetes', 1, null);

        self::assertCount(1, $result->rows);
        self::assertSame(2, $result->total);
    }

    public function testListRunsReturnsNewestFirstAcrossAllQueriesByDefault(): void
    {
        $this->seed();

        $result = $this->explorer->listRuns(null, 10, null);

        self::assertCount(2, $result->rows);
        self::assertSame(2, $result->total);
    }

    public function testPlanResetRefusesWithNoTarget(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/--query|--all/');
        $this->explorer->planReset(null, false, false);
    }

    public function testPlanResetPlansOneQueryWhenNamed(): void
    {
        $this->seed();

        $plans = $this->explorer->planReset('kubernetes', false, false);

        self::assertCount(1, $plans);
        self::assertSame('kubernetes', $plans[0]->querySlug);
        self::assertSame(2, $plans[0]->repos);
        self::assertFalse($plans[0]->deleteRuns);
    }

    public function testPlanResetPlansEveryQueryUnderAll(): void
    {
        $this->seed();

        $plans = $this->explorer->planReset(null, true, false);

        self::assertSame(['istio', 'kubernetes'], array_map(static fn ($p) => $p->querySlug, $plans));
    }

    public function testApplyResetDeletesCorpusAndStateKeepingRunHistory(): void
    {
        $this->seed();

        $plans = $this->explorer->planReset('kubernetes', false, false);
        $this->explorer->applyReset($plans);

        self::assertSame(0, $this->repos->countByQuerySlug('kubernetes'));
        self::assertNull($this->states->findByQuerySlug('kubernetes'));
        self::assertSame(1, $this->runs->countByQuerySlug('kubernetes'));
        // Untouched.
        self::assertSame(1, $this->repos->countByQuerySlug('istio'));
    }

    public function testApplyResetDeletesTheHistoryTooUnderIncludeRuns(): void
    {
        $this->seed();

        $plans = $this->explorer->planReset('kubernetes', false, true);
        $this->explorer->applyReset($plans);

        self::assertSame(0, $this->runs->countByQuerySlug('kubernetes'));
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        unset($this->em, $this->explorer, $this->repos, $this->runs, $this->states);
    }
}
