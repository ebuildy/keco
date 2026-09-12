<?php

declare(strict_types=1);

namespace App\Discovery\Console;

use App\Discovery\QuerySlug;
use App\Entity\DiscoveryRepo;
use App\Entity\DiscoveryRun;
use App\Repository\DiscoveryRepoRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoveryStateRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * `app:discovery:count|list|reset` — reading and clearing the discovery dataset, ported from
 * `apps/workers/src/discovery/explore.ts`. Data access only; the console commands render.
 */
final class DiscoveryExplorer
{
    /** @var list<string> */
    private const RUN_SORTABLE = ['startedAt', 'durationMs', 'reposNew', 'pagesFetched'];

    /** @var list<string> */
    private const REPO_SORTABLE = ['stars', 'pushedAt'];

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly DiscoveryRepoRepository $repos,
        private readonly DiscoveryRunRepository $runs,
        private readonly DiscoveryStateRepository $states,
    ) {
    }

    /**
     * The set of swept queries comes from `discovery_state`, one row per query — the only cheap
     * enumeration available, exactly like `explore.ts`'s rationale: a query is listed from the
     * moment its first sweep opens, before any repo or run row lands.
     *
     * @return list<CountRow>
     */
    public function count(?string $query): array
    {
        $states = null === $query
            ? $this->states->findAllOrderedBySlug()
            : array_filter([$this->states->findByQuerySlug(QuerySlug::of($query))]);

        return array_map(function ($state): CountRow {
            $slug = $state->getQuerySlug();

            return new CountRow(
                query: $state->getQuery(),
                querySlug: $slug,
                repos: $this->repos->countByQuerySlug($slug),
                runs: $this->runs->countByQuerySlug($slug),
                pendingWindows: \count($state->getPendingWindows()),
                lastRun: $this->runs->findLatestByQuerySlug($slug),
            );
        }, $states);
    }

    /**
     * Rejects an undeclared sort field by name — a backend given one either errors deep in a
     * client stack or quietly returns unsorted results, and the second failure shows the
     * operator a table that looks sorted and is not (AGENTS.md §13's TS equivalent rationale).
     *
     * @return array{0: string, 1: 'ASC'|'DESC'}
     */
    public function resolveSort(string $target, ?string $sort): array
    {
        $sortable = 'runs' === $target ? self::RUN_SORTABLE : self::REPO_SORTABLE;

        if (null === $sort) {
            return 'runs' === $target ? ['startedAt', 'DESC'] : ['stars', 'DESC'];
        }

        $parts = explode(':', $sort, 2);
        $field = $parts[0];
        $direction = strtolower($parts[1] ?? 'desc');

        if (!\in_array($field, $sortable, true)) {
            throw new \InvalidArgumentException(\sprintf(
                'cannot sort %s by "%s" — sortable fields are: %s',
                $target,
                $field,
                implode(', ', $sortable),
            ));
        }
        if ('asc' !== $direction && 'desc' !== $direction) {
            throw new \InvalidArgumentException(\sprintf('sort direction must be asc or desc, got "%s"', $direction));
        }

        return [$field, 'asc' === $direction ? 'ASC' : 'DESC'];
    }

    /**
     * @return ListResult<DiscoveryRun>
     */
    public function listRuns(?string $query, int $limit, ?string $sort): ListResult
    {
        [$field, $direction] = $this->resolveSort('runs', $sort);

        if (null !== $query) {
            $slug = QuerySlug::of($query);

            return new ListResult($this->runs->findByQuerySlug($slug, $limit, $field, $direction), $this->runs->countByQuerySlug($slug));
        }

        return new ListResult($this->runs->findAllOrdered($limit, $field, $direction), $this->runs->countAll());
    }

    /**
     * @return ListResult<DiscoveryRepo>
     */
    public function listRepos(?string $query, int $limit, ?string $sort): ListResult
    {
        [$field, $direction] = $this->resolveSort('repos', $sort);

        if (null !== $query) {
            $slug = QuerySlug::of($query);

            return new ListResult($this->repos->findByQuerySlug($slug, $limit, $field, $direction), $this->repos->countByQuerySlug($slug));
        }

        return new ListResult($this->repos->findAllOrdered($limit, $field, $direction), $this->repos->countAll());
    }

    /**
     * Works out what a reset would destroy, without destroying anything. Refuses with no
     * target: a reset that defaults to everything is a reset that eventually runs by accident.
     *
     * @return list<ResetPlan>
     */
    public function planReset(?string $query, bool $all, bool $includeRuns): array
    {
        if (null === $query && !$all) {
            throw new \InvalidArgumentException(
                'refusing to reset without a target — pass --query <keyword> for one query, or --all for every query',
            );
        }

        return array_map(
            static fn (CountRow $row): ResetPlan => new ResetPlan($row->query, $row->querySlug, $row->repos, $row->runs, $includeRuns),
            $this->count($query),
        );
    }

    /**
     * Applies a plan. Corpus first, then state, then — only if asked — the history, mirroring
     * `explore.ts`'s ordering rationale: a state row surviving over a partly-deleted corpus is
     * recoverable (the next sweep re-records what is missing); the reverse would strand rows
     * nothing will ever clean up.
     *
     * @param list<ResetPlan> $plans
     */
    public function applyReset(array $plans): void
    {
        foreach ($plans as $plan) {
            $this->repos->removeByQuerySlug($plan->querySlug);
            $this->states->removeByQuerySlug($plan->querySlug);
            if ($plan->deleteRuns) {
                $this->runs->removeByQuerySlug($plan->querySlug);
            }
        }

        // These are DQL bulk deletes, which run at the SQL level and bypass the UnitOfWork — a
        // DiscoveryState/DiscoveryRepo already managed from an earlier find() would otherwise
        // keep answering from the identity map as if the deleted rows still existed.
        $this->em->clear();
    }
}
