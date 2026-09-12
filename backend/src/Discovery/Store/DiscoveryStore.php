<?php

declare(strict_types=1);

namespace App\Discovery\Store;

use App\Discovery\Clock;
use App\Discovery\QuerySlug;
use App\Discovery\Search\SearchItem;
use App\Discovery\SweepState;
use App\Entity\DiscoveryRepo;
use App\Entity\DiscoveryRun;
use App\Entity\DiscoveryState;
use App\Repository\DiscoveryRepoRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoveryStateRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Uid\Ulid;

/**
 * Everything discovery reads and writes, over Doctrine — no filesystem, no DataStore port, no
 * key building (that whole abstraction retired with ADR 0002, per the migration design spec §3:
 * "Doctrine's EntityRepository *is* the abstraction"). Ported from
 * `apps/workers/src/discovery/store/store.ts`'s `DiscoveryStore`; this file owns the same
 * bookkeeping the TS version did: what counts as changed, which sighting wins, and when a flush
 * is due.
 *
 * The TS store's crash-safety property — "corpus first, then state, and state alone is
 * durable" — survives here even though Postgres gives real transactions: {@see flush()} issues
 * one `EntityManager::flush()` for the corpus batch(es) and a *separate*, later
 * `EntityManager::flush()` for the state row. If the process dies between the two, the corpus
 * rows are already committed but the state row hasn't advanced past them — exactly the
 * "durable state must never claim windows whose repos aren't written yet" invariant AGENTS.md
 * §4.1 requires, just enforced by two sequential commits instead of an ordered async `put`.
 */
final class DiscoveryStore
{
    /** Flush cadence: 25 windows or 30s, whichever comes first. See {@see windowCompleted()}. */
    private const FLUSH_WINDOW_COUNT = 25;
    private const FLUSH_INTERVAL_MS = 30_000;

    /** Upsert batch size — AGENTS.md §4's "batches of ≤1000". */
    private const WRITE_BATCH = 1000;

    /**
     * Repos already recorded in this process — what makes first-wins hold *within* a run.
     *
     * @var array<int, true>
     */
    private array $seenThisRun = [];

    /** @var array<string, PendingSighting> Buffered, not yet flushed; keyed by composite id. */
    private array $pending = [];

    private int $windowsSinceFlush = 0;
    private int $lastFlushAtMs;

    /**
     * Write outcomes for THIS process, as opposed to the sweep counters on `state`.
     *
     * @var array{new: int, changed: int, unchanged: int}
     */
    private array $runCounts = ['new' => 0, 'changed' => 0, 'unchanged' => 0];

    /**
     * Sweep-scoped counters as they stood when this process opened. Subtracting gives the
     * run-scoped numbers the history reports.
     *
     * @var array{pagesFetched: int, dropped: int, windowsCompleted: int, windowsFailed: int}
     */
    private readonly array $openedWith;

    public readonly SweepState $state;
    public readonly string $querySlug;
    public readonly string $runId;

    /**
     * @param array<int, array{payloadHash: string, firstSeenRunId: string}> $known keyed by repoId
     */
    private function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DiscoveryRepoRepository $repos,
        private readonly Clock $clock,
        private readonly string $query,
        string $querySlug,
        private array $known,
        SweepState $state,
        private readonly Ulid $runIdObject,
        private ?DiscoveryState $stateEntity,
        private DiscoveryRun $runEntity,
    ) {
        $this->querySlug = $querySlug;
        $this->state = $state;
        $this->runId = (string) $runIdObject;
        $this->lastFlushAtMs = $clock->now();
        $this->openedWith = [
            'pagesFetched' => $state->pagesFetched,
            'dropped' => $state->dropped,
            'windowsCompleted' => \count($state->completedWindows),
            'windowsFailed' => \count($state->failedWindows),
        ];
    }

    public static function open(
        EntityManagerInterface $em,
        DiscoveryRepoRepository $repos,
        DiscoveryRunRepository $runs,
        DiscoveryStateRepository $states,
        Clock $clock,
        string $query,
        OpenOptions $options,
    ): self {
        $now = $options->now ?? new \DateTimeImmutable();
        // Throws for a query with no usable slug — before any I/O.
        $querySlug = QuerySlug::of($query);
        $runId = $options->runId ?? new Ulid();

        if ($options->fresh) {
            // `--fresh` deletes rather than merely ignoring, so a fresh sweep genuinely starts
            // clean (AGENTS.md §4.1).
            $repos->removeByQuerySlug($querySlug);
            $states->removeByQuerySlug($querySlug);
            // DQL bulk deletes run at the SQL level and bypass the UnitOfWork, so any
            // already-managed DiscoveryState/DiscoveryRepo for this slug would otherwise still
            // answer from the identity map as if the rows still existed.
            $em->clear();
        }

        $stateEntity = $options->fresh ? null : $states->findByQuerySlug($querySlug);

        // Only load the corpus once there is state to resume: state is what says how far the
        // sweep got, so a query with repo rows but no state is a cold start, not a partial one.
        $known = null !== $stateEntity ? $repos->knownByQuerySlug($querySlug) : [];

        $sweepState = null !== $stateEntity
            ? SweepStateMapper::fromEntity($stateEntity)
            : SweepStateMapper::newState($query, $now);

        // Written immediately, not at the end: a sweep that is killed still leaves evidence it
        // started, and outcome=running in the history is exactly how an operator spots one that
        // never finished (AGENTS.md §4.1).
        $runEntity = new DiscoveryRun($runId, $query, $querySlug, $now, $options->fresh, $options->limit);
        $runs->save($runEntity, flush: true);

        return new self(
            $em,
            $repos,
            $clock,
            $query,
            $querySlug,
            $known,
            $sweepState,
            $runId,
            $stateEntity,
            $runEntity,
        );
    }

    public function size(): int
    {
        return \count($this->known);
    }

    /**
     * Records one search hit, buffering it only when the payload changed. The first window to
     * find a repo owns its `discoveredVia`; later sightings are dropped.
     *
     * @return 'new'|'changed'|'unchanged'
     */
    public function record(SearchItem $item, string $via, \DateTimeImmutable $now): string
    {
        if (isset($this->seenThisRun[$item->id])) {
            ++$this->runCounts['unchanged'];

            return 'unchanged';
        }

        $hash = PayloadHash::of($item);
        $existing = $this->known[$item->id] ?? null;
        if (null !== $existing && $existing['payloadHash'] === $hash) {
            $this->seenThisRun[$item->id] = true;
            ++$this->runCounts['unchanged'];

            return 'unchanged';
        }

        $isNew = null === $existing;
        $firstSeenRunId = $isNew ? $this->runId : $existing['firstSeenRunId'];
        $id = QuerySlug::repoId($this->querySlug, $item->id);

        $this->pending[$id] = new PendingSighting(
            id: $id,
            item: $item,
            payloadHash: $hash,
            firstSeenRunId: $firstSeenRunId,
            isNew: $isNew,
            discoveredVia: $via,
            discoveredAt: $now,
        );
        $this->known[$item->id] = ['payloadHash' => $hash, 'firstSeenRunId' => $firstSeenRunId];
        $this->seenThisRun[$item->id] = true;

        if ($isNew) {
            ++$this->runCounts['new'];

            return 'new';
        }

        ++$this->runCounts['changed'];

        return 'changed';
    }

    /**
     * Call once a window's results have all been recorded. Windows, not records, are the unit
     * the flush policy counts in: a window is also the retry granularity, so there is no finer
     * notion of progress.
     *
     * Returns whether a flush actually ran, so a test can assert on it without reaching into
     * private counters.
     */
    public function windowCompleted(?\DateTimeImmutable $now = null): bool
    {
        $now ??= new \DateTimeImmutable();
        ++$this->windowsSinceFlush;
        $due = $this->windowsSinceFlush >= self::FLUSH_WINDOW_COUNT
            || $this->clock->now() - $this->lastFlushAtMs >= self::FLUSH_INTERVAL_MS;
        if (!$due) {
            return false;
        }
        $this->flush($now);

        return true;
    }

    /**
     * Corpus first, then state — the order is load-bearing (see the class docblock). Unlike the
     * TS store's async queue, PHP has no concurrent flush to serialise against; this method is
     * simply not reentrant, which is sufficient here since discovery is single-process.
     */
    public function flush(?\DateTimeImmutable $now = null): void
    {
        $now ??= new \DateTimeImmutable();

        // Snapshot at the instant of the write, never cached from an earlier record().
        $this->state->reposSeen = \count($this->known);

        $pending = $this->pending;
        $this->pending = [];

        if ([] !== $pending) {
            $this->writeCorpus($pending);
        }

        $this->persistState($now);

        $this->windowsSinceFlush = 0;
        $this->lastFlushAtMs = $this->clock->now();
    }

    /**
     * @param array<string, PendingSighting> $pending
     */
    private function writeCorpus(array $pending): void
    {
        $changedIds = array_values(array_map(
            static fn (PendingSighting $s): string => $s->id,
            array_filter($pending, static fn (PendingSighting $s): bool => !$s->isNew),
        ));

        $existingById = [];
        if ([] !== $changedIds) {
            foreach ($this->repos->findBy(['id' => $changedIds]) as $entity) {
                $existingById[$entity->getId()] = $entity;
            }
        }

        foreach (array_chunk(array_keys($pending), self::WRITE_BATCH) as $chunk) {
            foreach ($chunk as $id) {
                $sighting = $pending[$id];
                $existing = $existingById[$id] ?? null;
                if (null !== $existing) {
                    $this->applySighting($existing, $sighting);
                } else {
                    $this->em->persist($this->buildEntity($sighting));
                }
            }
            $this->em->flush();
        }
    }

    private function buildEntity(PendingSighting $sighting): DiscoveryRepo
    {
        $item = $sighting->item;

        return new DiscoveryRepo(
            id: $sighting->id,
            repoId: $item->id,
            querySlug: $this->querySlug,
            query: $this->query,
            fullName: $item->fullName,
            name: $item->name,
            owner: $item->ownerLogin ?? (explode('/', $item->fullName)[0]),
            description: $item->description,
            homepage: $item->homepage,
            stars: $item->stargazersCount,
            forks: $item->forksCount,
            openIssues: $item->openIssuesCount,
            language: $item->language,
            license: $item->license,
            topics: $item->topics,
            archived: $item->archived,
            fork: $item->fork,
            defaultBranch: $item->defaultBranch,
            githubCreatedAt: $item->createdAt,
            githubUpdatedAt: $item->updatedAt,
            githubPushedAt: $item->pushedAt,
            discoveredVia: $sighting->discoveredVia,
            discoveredAt: $sighting->discoveredAt,
            payloadHash: $sighting->payloadHash,
            firstSeenRunId: $sighting->firstSeenRunId,
            lastSeenRunId: $this->runId,
        );
    }

    private function applySighting(DiscoveryRepo $entity, PendingSighting $sighting): void
    {
        $item = $sighting->item;
        $entity->updateSighting(
            fullName: $item->fullName,
            name: $item->name,
            owner: $item->ownerLogin ?? (explode('/', $item->fullName)[0]),
            description: $item->description,
            homepage: $item->homepage,
            stars: $item->stargazersCount,
            forks: $item->forksCount,
            openIssues: $item->openIssuesCount,
            language: $item->language,
            license: $item->license,
            topics: $item->topics,
            archived: $item->archived,
            fork: $item->fork,
            defaultBranch: $item->defaultBranch,
            githubCreatedAt: $item->createdAt,
            githubUpdatedAt: $item->updatedAt,
            githubPushedAt: $item->pushedAt,
            payloadHash: $sighting->payloadHash,
            lastSeenRunId: $this->runId,
        );
    }

    private function persistState(\DateTimeImmutable $now): void
    {
        $pendingWindows = SweepStateMapper::pendingWindowsToArray($this->state);
        $failedWindows = SweepStateMapper::failedWindowsToArray($this->state);

        if (null === $this->stateEntity) {
            $this->stateEntity = new DiscoveryState(
                querySlug: $this->querySlug,
                query: $this->query,
                startedAt: new \DateTimeImmutable($this->state->startedAt),
                updatedAt: $now,
                currentRunId: $this->runId,
                pendingWindows: $pendingWindows,
                completedWindows: $this->state->completedWindows,
                failedWindows: $failedWindows,
                reposSeen: $this->state->reposSeen,
                pagesFetched: $this->state->pagesFetched,
                dropped: $this->state->dropped,
            );
            $this->em->persist($this->stateEntity);
        } else {
            $this->stateEntity->applySnapshot(
                currentRunId: $this->runId,
                updatedAt: $now,
                pendingWindows: $pendingWindows,
                completedWindows: $this->state->completedWindows,
                failedWindows: $failedWindows,
                reposSeen: $this->state->reposSeen,
                pagesFetched: $this->state->pagesFetched,
                dropped: $this->state->dropped,
            );
        }

        // The separate, later commit from writeCorpus()'s — this is the half of the ordering
        // that must land last.
        $this->em->flush();
    }

    /**
     * Stamps the run's ending. Called on every path out of the orchestrator — normal
     * completion, a failed-window exit, and the shutdown handler.
     *
     * A `SIGKILL` never reaches here, so that run stays `running` in the history forever —
     * deliberate: the stuck row is the signal a sweep died without cleanup (AGENTS.md §4.1).
     */
    public function finishRun(string $outcome, ?\DateTimeImmutable $now = null, bool $stoppedAtLimit = false): void
    {
        $now ??= new \DateTimeImmutable();

        $this->runEntity->recordProgress(
            pagesFetched: $this->state->pagesFetched - $this->openedWith['pagesFetched'],
            dropped: $this->state->dropped - $this->openedWith['dropped'],
            reposNew: $this->runCounts['new'],
            reposChanged: $this->runCounts['changed'],
            reposUnchanged: $this->runCounts['unchanged'],
            windowsCompleted: \count($this->state->completedWindows) - $this->openedWith['windowsCompleted'],
            windowsFailed: \count($this->state->failedWindows) - $this->openedWith['windowsFailed'],
            sweepReposTotal: \count($this->known),
            sweepWindowsPending: \count($this->state->pendingWindows),
            stoppedAtLimit: $stoppedAtLimit,
            failedWindows: SweepStateMapper::failedWindowsToArray($this->state),
        );
        $this->runEntity->finish($outcome, $now);
        $this->em->flush();
    }
}
