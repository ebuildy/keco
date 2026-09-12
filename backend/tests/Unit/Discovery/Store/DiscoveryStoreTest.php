<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery\Store;

use App\Discovery\SystemClock;
use App\Discovery\Search\SearchItem;
use App\Discovery\Store\DiscoveryStore;
use App\Discovery\Store\OpenOptions;
use App\Repository\DiscoveryRepoRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoveryStateRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Uid\Ulid;

/**
 * Ported in spirit from `store/store.test.ts` — round-tripped through real Postgres, since this
 * class's whole job is the Doctrine mapping the pure `App\Discovery` unit tests can't exercise.
 */
final class DiscoveryStoreTest extends KernelTestCase
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
     * @param array<string, mixed> $overrides
     */
    private static function item(array $overrides = []): SearchItem
    {
        $data = array_merge([
            'id' => 1,
            'full_name' => 'kubernetes/kubectl',
            'name' => 'kubectl',
            'owner' => ['login' => 'kubernetes'],
            'description' => null,
            'homepage' => null,
            'stargazers_count' => 10,
            'forks_count' => 1,
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
        ], $overrides);

        return SearchItem::fromArray($data);
    }

    private function open(string $query = 'kubernetes', bool $fresh = false, ?Ulid $runId = null): DiscoveryStore
    {
        return DiscoveryStore::open(
            $this->em,
            $this->repos,
            $this->runs,
            $this->states,
            new SystemClock(),
            $query,
            new OpenOptions(fresh: $fresh, now: new \DateTimeImmutable('2026-08-02T00:00:00Z'), runId: $runId),
        );
    }

    public function testRecordsANewRepoAndWritesItOnFlushNotBefore(): void
    {
        $store = $this->open();
        $outcome = $store->record(self::item(), 'kubernetes stars:>5000', new \DateTimeImmutable());

        self::assertSame('new', $outcome);
        self::assertSame(0, $this->repos->countByQuerySlug('kubernetes'));

        $store->flush();

        self::assertSame(1, $this->repos->countByQuerySlug('kubernetes'));
    }

    public function testReportsARepoAlreadySeenThisRunAsUnchangedWithoutRewritingIt(): void
    {
        $store = $this->open();
        $store->record(self::item(), 'a', new \DateTimeImmutable());
        $outcome = $store->record(self::item(), 'b', new \DateTimeImmutable());

        self::assertSame('unchanged', $outcome);
        self::assertSame(1, $store->size());
    }

    public function testResumesAnUnchangedPayloadIsNotRewrittenOnTheNextRun(): void
    {
        $first = $this->open(runId: new Ulid());
        $first->record(self::item(), 'a', new \DateTimeImmutable());
        $first->flush();
        $first->finishRun('complete');

        $second = $this->open(runId: new Ulid());
        $outcome = $second->record(self::item(), 'a', new \DateTimeImmutable());

        self::assertSame('unchanged', $outcome);
    }

    public function testResumesAChangedPayloadIsRewrittenKeepingItsFirstSeenRunId(): void
    {
        $firstRunId = new Ulid();
        $first = $this->open(runId: $firstRunId);
        $first->record(self::item(), 'a', new \DateTimeImmutable());
        $first->flush();
        $first->finishRun('complete');

        $secondRunId = new Ulid();
        $second = $this->open(runId: $secondRunId);
        $outcome = $second->record(self::item(['stargazers_count' => 999]), 'a', new \DateTimeImmutable());
        self::assertSame('changed', $outcome);
        $second->flush();

        $repo = $this->repos->find('kubernetes_1');
        self::assertNotNull($repo);
        self::assertSame(999, $repo->getStars());
        self::assertSame((string) $firstRunId, $repo->getFirstSeenRunId());
        self::assertSame((string) $secondRunId, $repo->getLastSeenRunId());
    }

    public function testStartsColdWhenThereIsNoStateEvenIfRepoDocumentsExist(): void
    {
        $first = $this->open();
        $first->record(self::item(), 'a', new \DateTimeImmutable());
        $first->flush();
        // Delete only the state row, leaving the corpus behind — same scenario windows.ts's
        // TS counterpart test sets up manually.
        $this->states->removeByQuerySlug('kubernetes');
        $this->em->clear();

        $second = $this->open();
        // A cold start means the known map is empty, so re-seeing the same repo counts as "new".
        $outcome = $second->record(self::item(), 'a', new \DateTimeImmutable());
        self::assertSame('new', $outcome);
    }

    public function testFreshDeletesThisQueryAndOnlyThisQuery(): void
    {
        $k8s = $this->open('kubernetes');
        $k8s->record(self::item(), 'a', new \DateTimeImmutable());
        $k8s->flush();
        $k8s->finishRun('complete');

        $istio = $this->open('istio');
        $istio->record(self::item(['id' => 2, 'full_name' => 'istio/istio', 'name' => 'istio', 'owner' => ['login' => 'istio']]), 'a', new \DateTimeImmutable());
        $istio->flush();
        $istio->finishRun('complete');

        $this->open('kubernetes', fresh: true);

        self::assertSame(0, $this->repos->countByQuerySlug('kubernetes'));
        self::assertNull($this->states->findByQuerySlug('kubernetes'));
        self::assertSame(1, $this->repos->countByQuerySlug('istio'));
        self::assertNotNull($this->states->findByQuerySlug('istio'));
        // --fresh never deletes run history — the count only grows (the first sweep's run, plus
        // the run --fresh itself just opened), it never shrinks back to 1.
        self::assertSame(2, $this->runs->countByQuerySlug('kubernetes'));
    }

    public function testWritesARunningRecordTheMomentTheStoreOpens(): void
    {
        $this->open();

        $run = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($run);
        self::assertSame('running', $run->getOutcome());
    }

    public function testFinishRunStampsTheEndingAndRunScopedCounters(): void
    {
        $store = $this->open();
        $store->record(self::item(), 'a', new \DateTimeImmutable());
        $store->record(self::item(['id' => 2, 'full_name' => 'a/two', 'name' => 'two', 'owner' => ['login' => 'a']]), 'a', new \DateTimeImmutable());
        $store->flush();
        $store->finishRun('complete');

        $run = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($run);
        self::assertSame('complete', $run->getOutcome());
        self::assertNotNull($run->getEndedAt());
    }

    public function testLeavesAKilledRunAtRunningRatherThanRewritingHistory(): void
    {
        // No finishRun() call — the process "dies" here, standing in for a SIGKILL that bypasses
        // every signal handler.
        $this->open();

        $run = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($run);
        self::assertSame('running', $run->getOutcome());
        self::assertNull($run->getEndedAt());
    }

    public function testWindowCompletedFlushesOnThe25thWindowNotBefore(): void
    {
        $store = $this->open();
        $store->record(self::item(), 'a', new \DateTimeImmutable());

        for ($i = 1; $i < 25; ++$i) {
            self::assertFalse($store->windowCompleted());
        }
        self::assertSame(0, $this->repos->countByQuerySlug('kubernetes'));

        self::assertTrue($store->windowCompleted());
        self::assertSame(1, $this->repos->countByQuerySlug('kubernetes'));
    }

    /**
     * The counterpart to the entity-level "killed run stays running forever" test: a *graceful*
     * interruption (what `InterruptHandler` calls on SIGINT/SIGTERM) explicitly marks the run
     * `interrupted` rather than leaving it stuck — the two behaviors are deliberately different,
     * and this pins the distinction.
     */
    public function testAGracefulInterruptionMarksTheRunInterruptedNotComplete(): void
    {
        $store = $this->open();
        $store->record(self::item(), 'a', new \DateTimeImmutable());

        // What DiscoverySweepRunner's InterruptHandler callback does on SIGINT/SIGTERM.
        $store->flush();
        $store->finishRun('interrupted');

        $run = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($run);
        self::assertSame('interrupted', $run->getOutcome());
        self::assertNotNull($run->getEndedAt());
        self::assertSame(1, $this->repos->countByQuerySlug('kubernetes'));
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        unset($this->em, $this->repos, $this->runs, $this->states);
    }
}
