<?php

declare(strict_types=1);

namespace App\Tests\Unit\Entity;

use App\Entity\DiscoveryRun;
use App\Entity\DiscoverySighting;
use App\Entity\DiscoveryState;
use App\Entity\GithubRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoverySightingRepository;
use App\Repository\DiscoveryStateRepository;
use App\Repository\GithubRepositoryRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Uid\Ulid;

/**
 * Round-trips the Discovery write model through real Postgres — the Doctrine mapping proof the
 * pure `App\Discovery` unit tests can't give, since they never touch an entity.
 *
 * `GithubRepository` and `DiscoverySighting` are tested separately here (AGENTS.md §4.1):
 * `GithubRepository` is the deduplicated, query-agnostic snapshot, keyed by GitHub's own repo
 * id; `DiscoverySighting` is one query's relationship to it, keyed by the composite
 * `"{querySlug}_{repoId}"` id and pointing at the `GithubRepository` row via a `ManyToOne`.
 */
final class DiscoveryEntitiesTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private GithubRepositoryRepository $repos;
    private DiscoverySightingRepository $sightings;
    private DiscoveryRunRepository $runs;
    private DiscoveryStateRepository $states;

    protected function setUp(): void
    {
        self::bootKernel();
        $container = static::getContainer();

        $this->em = $container->get(EntityManagerInterface::class);
        $this->repos = $container->get(GithubRepositoryRepository::class);
        $this->sightings = $container->get(DiscoverySightingRepository::class);
        $this->runs = $container->get(DiscoveryRunRepository::class);
        $this->states = $container->get(DiscoveryStateRepository::class);

        $this->em->getConnection()->executeStatement('TRUNCATE TABLE discovery_sightings, github_repositories, discovery_runs, discovery_state');
    }

    private function buildRepository(int $repoId = 1, int $stars = 10, string $payloadHash = 'hash1'): GithubRepository
    {
        return new GithubRepository(
            repoId: $repoId,
            fullName: 'a/one',
            name: 'one',
            owner: 'a',
            description: null,
            homepage: null,
            stars: $stars,
            forks: 0,
            openIssues: 0,
            language: 'Go',
            license: null,
            topics: ['cli'],
            archived: false,
            fork: false,
            defaultBranch: 'main',
            githubCreatedAt: '2020-01-01T00:00:00Z',
            githubUpdatedAt: '2020-01-01T00:00:00Z',
            githubPushedAt: null,
            payloadHash: $payloadHash,
        );
    }

    public function testGithubRepositoryRoundTripsAndUpdateSnapshotRewritesInPlace(): void
    {
        $repo = $this->buildRepository();

        $this->repos->save($repo, flush: true);
        $this->em->clear();

        $reloaded = $this->repos->find(1);
        self::assertNotNull($reloaded);
        self::assertSame(10, $reloaded->getStars());
        self::assertSame('hash1', $reloaded->getPayloadHash());

        $reloaded->updateSnapshot(
            fullName: 'a/one',
            name: 'one',
            owner: 'a',
            description: 'now described',
            homepage: null,
            stars: 42,
            forks: 1,
            openIssues: 2,
            language: 'Go',
            license: 'MIT',
            topics: ['cli', 'kubernetes'],
            archived: false,
            fork: false,
            defaultBranch: 'main',
            githubCreatedAt: '2020-01-01T00:00:00Z',
            githubUpdatedAt: '2026-01-01T00:00:00Z',
            githubPushedAt: '2026-01-01T00:00:00Z',
            payloadHash: 'hash2',
        );
        $this->em->flush();
        $this->em->clear();

        $updated = $this->repos->find(1);
        self::assertNotNull($updated);
        self::assertSame(42, $updated->getStars());
        self::assertSame('hash2', $updated->getPayloadHash());
    }

    public function testDiscoverySightingRoundTripsAndUpdateSightingRewritesPayloadHashKeepingFirstSeen(): void
    {
        $repo = $this->buildRepository();
        $this->repos->save($repo, flush: true);

        $sighting = new DiscoverySighting(
            id: 'kubernetes_1',
            repository: $repo,
            querySlug: 'kubernetes',
            query: 'kubernetes',
            discoveredVia: 'kubernetes stars:>5000',
            discoveredAt: new \DateTimeImmutable('2026-08-02T00:00:00Z'),
            payloadHash: 'hash1',
            firstSeenRunId: 'RUN1',
            lastSeenRunId: 'RUN1',
        );
        $this->sightings->save($sighting, flush: true);
        $this->em->clear();

        $reloaded = $this->sightings->find('kubernetes_1');
        self::assertNotNull($reloaded);
        self::assertSame(1, $reloaded->getRepoId());
        self::assertSame('hash1', $reloaded->getPayloadHash());
        self::assertSame('RUN1', $reloaded->getFirstSeenRunId());

        $reloaded->updateSighting(payloadHash: 'hash2', lastSeenRunId: 'RUN2');
        $this->em->flush();
        $this->em->clear();

        $updated = $this->sightings->find('kubernetes_1');
        self::assertNotNull($updated);
        self::assertSame('hash2', $updated->getPayloadHash());
        // first_seen_run_id survives an update — first-wins (AGENTS.md §4.1).
        self::assertSame('RUN1', $updated->getFirstSeenRunId());
        self::assertSame('RUN2', $updated->getLastSeenRunId());
    }

    public function testKnownByQuerySlugProjectsOnlyTheResumeFields(): void
    {
        $repo = $this->buildRepository(repoId: 2, stars: 5, payloadHash: 'hashX');
        $this->repos->save($repo, flush: true);

        $sighting = new DiscoverySighting(
            id: 'kubernetes_2',
            repository: $repo,
            querySlug: 'kubernetes',
            query: 'kubernetes',
            discoveredVia: 'kubernetes stars:1',
            discoveredAt: new \DateTimeImmutable(),
            payloadHash: 'hashX',
            firstSeenRunId: 'RUN1',
            lastSeenRunId: 'RUN1',
        );
        $this->sightings->save($sighting, flush: true);
        $this->em->clear();

        $known = $this->sightings->knownByQuerySlug('kubernetes');

        self::assertSame(['payloadHash' => 'hashX', 'firstSeenRunId' => 'RUN1'], $known[2]);
        self::assertSame(1, $this->sightings->countByQuerySlug('kubernetes'));
        self::assertSame(0, $this->sightings->countByQuerySlug('other'));
    }

    /**
     * The scenario this whole split exists to prevent: two queries finding the same actual
     * GitHub repo must produce exactly one `GithubRepository` row and one `DiscoverySighting`
     * row per query — never a second `GithubRepository` row (AGENTS.md §4.1).
     */
    public function testTwoQueriesSightingTheSameRepoShareOneGithubRepositoryRow(): void
    {
        $repo = $this->buildRepository(repoId: 3, stars: 100, payloadHash: 'shared-hash');
        $this->repos->save($repo, flush: true);

        $this->sightings->save(new DiscoverySighting(
            id: 'kubernetes_3',
            repository: $repo,
            querySlug: 'kubernetes',
            query: 'kubernetes',
            discoveredVia: 'kubernetes stars:>50',
            discoveredAt: new \DateTimeImmutable(),
            payloadHash: 'shared-hash',
            firstSeenRunId: 'RUN1',
            lastSeenRunId: 'RUN1',
        ), flush: true);
        $this->sightings->save(new DiscoverySighting(
            id: 'cli-tools_3',
            repository: $repo,
            querySlug: 'cli-tools',
            query: 'cli tools',
            discoveredVia: 'cli tools stars:>50',
            discoveredAt: new \DateTimeImmutable(),
            payloadHash: 'shared-hash',
            firstSeenRunId: 'RUN2',
            lastSeenRunId: 'RUN2',
        ), flush: true);
        $this->em->clear();

        self::assertSame(1, $this->repos->countAll());
        self::assertSame(1, $this->sightings->countByQuerySlug('kubernetes'));
        self::assertSame(1, $this->sightings->countByQuerySlug('cli-tools'));
    }

    public function testDiscoveryRunOpensRunningAndFinishStampsTheEnding(): void
    {
        $run = new DiscoveryRun(
            id: new Ulid(),
            query: 'kubernetes',
            querySlug: 'kubernetes',
            startedAt: new \DateTimeImmutable('2026-08-02T00:00:00Z'),
            fresh: false,
            limit: null,
        );
        $this->runs->save($run, flush: true);
        $this->em->clear();

        $reloaded = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($reloaded);
        self::assertSame('running', $reloaded->getOutcome());
        self::assertNull($reloaded->getEndedAt());

        $reloaded->finish('complete', new \DateTimeImmutable('2026-08-02T00:05:00Z'));
        $this->em->flush();
        $this->em->clear();

        $finished = $this->runs->findLatestByQuerySlug('kubernetes');
        self::assertNotNull($finished);
        self::assertSame('complete', $finished->getOutcome());
        self::assertNotNull($finished->getEndedAt());
    }

    /**
     * The deliberate stuck-row behavior (AGENTS.md §4.1): a process that dies before calling
     * `finish()` — the equivalent of a SIGKILL, which cannot be trapped — leaves its run at
     * `running` forever. Simulated here by simply never finishing it and re-reading from a
     * fresh entity manager, standing in for "another process looks at this row later.".
     */
    public function testAKilledRunStaysAtRunningForever(): void
    {
        $run = new DiscoveryRun(
            id: new Ulid(),
            query: 'kubernetes',
            querySlug: 'kubernetes',
            startedAt: new \DateTimeImmutable(),
            fresh: false,
            limit: 3,
        );
        $this->runs->save($run, flush: true);
        $this->em->clear();

        // No finish() call — the process "dies" here, exactly like a SIGKILL bypassing every
        // signal handler.
        $reloaded = $this->runs->findLatestByQuerySlug('kubernetes');

        self::assertNotNull($reloaded);
        self::assertSame('running', $reloaded->getOutcome());
        self::assertNull($reloaded->getEndedAt());
    }

    public function testFinishRejectsReMarkingAsRunning(): void
    {
        $run = new DiscoveryRun(new Ulid(), 'kubernetes', 'kubernetes', new \DateTimeImmutable(), false, null);

        $this->expectException(\InvalidArgumentException::class);
        $run->finish('running', new \DateTimeImmutable());
    }

    public function testDiscoveryStateRoundTripsAndApplySnapshotReplacesTheWholeDocument(): void
    {
        $state = new DiscoveryState(
            querySlug: 'kubernetes',
            query: 'kubernetes',
            startedAt: new \DateTimeImmutable('2026-08-02T00:00:00Z'),
            updatedAt: new \DateTimeImmutable('2026-08-02T00:00:00Z'),
            currentRunId: 'RUN1',
            pendingWindows: [['base' => 'kubernetes', 'stars' => '0', 'created' => null]],
            completedWindows: ['kubernetes stars:>5000'],
            failedWindows: [],
            reposSeen: 5,
            pagesFetched: 3,
            dropped: 0,
        );
        $this->states->save($state, flush: true);
        $this->em->clear();

        $reloaded = $this->states->findByQuerySlug('kubernetes');
        self::assertNotNull($reloaded);
        self::assertCount(1, $reloaded->getPendingWindows());
        self::assertSame(5, $reloaded->getReposSeen());

        $reloaded->applySnapshot(
            currentRunId: 'RUN2',
            updatedAt: new \DateTimeImmutable('2026-08-02T01:00:00Z'),
            pendingWindows: [],
            completedWindows: ['kubernetes stars:>5000', 'kubernetes stars:0'],
            failedWindows: [['window' => 'kubernetes stars:1', 'error' => 'boom']],
            reposSeen: 9,
            pagesFetched: 4,
            dropped: 1,
        );
        $this->em->flush();
        $this->em->clear();

        $updated = $this->states->findByQuerySlug('kubernetes');
        self::assertNotNull($updated);
        self::assertSame([], $updated->getPendingWindows());
        self::assertSame(9, $updated->getReposSeen());
        self::assertSame(1, $updated->getDropped());
        self::assertCount(1, $updated->getFailedWindows());
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        unset($this->em, $this->repos, $this->sightings, $this->runs, $this->states);
    }
}
