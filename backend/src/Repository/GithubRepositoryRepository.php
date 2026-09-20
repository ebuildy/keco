<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\GithubRepository;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * The global, deduplicated corpus: one row per actual GitHub repo, full stop. No query
 * provenance here — that lives in {@see DiscoverySightingRepository}. This is deliberately the
 * shape the crawler's future worklist read needs: "give me every `GithubRepository`", a plain
 * read with no join for the common, unscoped case (AGENTS.md §4.1/§4.2).
 *
 * @extends ServiceEntityRepository<GithubRepository>
 */
class GithubRepositoryRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, GithubRepository::class);
    }

    public function save(GithubRepository $repo, bool $flush = false): void
    {
        $this->getEntityManager()->persist($repo);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    /**
     * @param list<int> $repoIds
     *
     * @return array<int, GithubRepository> keyed by repoId
     */
    public function findByRepoIds(array $repoIds): array
    {
        if ([] === $repoIds) {
            return [];
        }

        $rows = $this->createQueryBuilder('r')
            ->andWhere('r.repoId IN (:ids)')
            ->setParameter('ids', $repoIds)
            ->getQuery()
            ->getResult();

        $byId = [];
        foreach ($rows as $row) {
            /* @var GithubRepository $row */
            $byId[$row->getRepoId()] = $row;
        }

        return $byId;
    }

    /**
     * @return list<GithubRepository>
     */
    public function findAllOrdered(int $limit, string $sortField = 'stars', string $sortDirection = 'DESC'): array
    {
        /* @var list<GithubRepository> */
        return $this->createQueryBuilder('r')
            ->orderBy('r.'.$sortField, $sortDirection)
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    public function countAll(): int
    {
        /** @var int $count */
        $count = $this->createQueryBuilder('r')
            ->select('COUNT(r.repoId)')
            ->getQuery()
            ->getSingleScalarResult();

        return $count;
    }

    /**
     * Deletes every repo in `$repoIds` that no `DiscoverySighting` references anywhere — a repo
     * no query currently sees isn't part of any corpus (AGENTS.md §4.1). Never deletes a repo
     * another query still has a live sighting on: the caller passes only the repo ids affected
     * by the sighting deletion that just ran, and this method re-checks each one against
     * `discovery_sightings` before removing it.
     *
     * @param list<int> $repoIds candidate repo ids — typically the ones just orphaned by a
     *                           sighting deletion, not the whole corpus
     */
    public function removeOrphans(array $repoIds): int
    {
        if ([] === $repoIds) {
            return 0;
        }

        return $this->createQueryBuilder('r')
            ->delete()
            ->andWhere('r.repoId IN (:ids)')
            ->andWhere('NOT EXISTS (SELECT 1 FROM App\Entity\DiscoverySighting s WHERE s.repository = r)')
            ->setParameter('ids', $repoIds)
            ->getQuery()
            ->execute();
    }
}
