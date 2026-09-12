<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\DiscoverySighting;
use App\Entity\GithubRepository;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * One `(query_slug, repo_id)` pair per row — inherently query-scoped, unlike
 * {@see GithubRepositoryRepository}'s global, deduplicated corpus.
 *
 * @extends ServiceEntityRepository<DiscoverySighting>
 */
class DiscoverySightingRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, DiscoverySighting::class);
    }

    public function save(DiscoverySighting $sighting, bool $flush = false): void
    {
        $this->getEntityManager()->persist($sighting);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    public function countByQuerySlug(string $querySlug): int
    {
        /** @var int $count */
        $count = $this->createQueryBuilder('s')
            ->select('COUNT(s.id)')
            ->andWhere('s.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->getQuery()
            ->getSingleScalarResult();

        return $count;
    }

    /**
     * The resume path's known-repo map: this query's own sighting state, keyed by repoId. Moved
     * here from `GithubRepositoryRepository` (AGENTS.md §4.1's TS equivalent, `KnownRepoSchema`)
     * because a resume position is inherently a per-query concept now that a repo's own row is
     * shared across queries.
     *
     * @return array<int, array{payloadHash: string, firstSeenRunId: string}> keyed by repoId
     */
    public function knownByQuerySlug(string $querySlug): array
    {
        $rows = $this->createQueryBuilder('s')
            ->select('IDENTITY(s.repository) AS repoId', 's.payloadHash AS payloadHash', 's.firstSeenRunId AS firstSeenRunId')
            ->andWhere('s.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->getQuery()
            ->getArrayResult();

        $known = [];
        foreach ($rows as $row) {
            /** @var array{repoId: int|string, payloadHash: string, firstSeenRunId: string} $row */
            $known[(int) $row['repoId']] = ['payloadHash' => $row['payloadHash'], 'firstSeenRunId' => $row['firstSeenRunId']];
        }

        return $known;
    }

    /**
     * This query's sighted repos, joined through to their (globally deduplicated)
     * `GithubRepository` row — the columns a listing actually displays (stars, language, pushed
     * at) live there, not on the sighting.
     *
     * @return list<GithubRepository>
     */
    public function findRepositoriesByQuerySlug(string $querySlug, int $limit, string $sortField = 'stars', string $sortDirection = 'DESC'): array
    {
        /** @var list<GithubRepository> */
        return $this->getEntityManager()->createQueryBuilder()
            ->select('r')
            ->from(GithubRepository::class, 'r')
            ->join(DiscoverySighting::class, 's', 'WITH', 's.repository = r')
            ->andWhere('s.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->orderBy('r.'.$sortField, $sortDirection)
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /**
     * Every repo id this query currently has a sighting on — read before a `--fresh`/reset
     * delete so the caller knows which `GithubRepository` rows to re-check for orphanhood
     * afterwards (AGENTS.md §4.1).
     *
     * @return list<int>
     */
    public function repoIdsByQuerySlug(string $querySlug): array
    {
        $rows = $this->createQueryBuilder('s')
            ->select('IDENTITY(s.repository) AS repoId')
            ->andWhere('s.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->getQuery()
            ->getArrayResult();

        $repoIds = [];
        foreach ($rows as $row) {
            /** @var array{repoId: int|string} $row */
            $repoIds[] = (int) $row['repoId'];
        }

        return $repoIds;
    }

    /** Deletes every sighting for one query — `--fresh` and `discovery:reset`'s corpus wipe. */
    public function removeByQuerySlug(string $querySlug): int
    {
        return $this->createQueryBuilder('s')
            ->delete()
            ->andWhere('s.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->getQuery()
            ->execute();
    }
}
