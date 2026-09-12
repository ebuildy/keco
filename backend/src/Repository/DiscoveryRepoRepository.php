<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\DiscoveryRepo;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<DiscoveryRepo>
 */
class DiscoveryRepoRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, DiscoveryRepo::class);
    }

    public function save(DiscoveryRepo $repo, bool $flush = false): void
    {
        $this->getEntityManager()->persist($repo);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    public function countByQuerySlug(string $querySlug): int
    {
        /** @var int $count */
        $count = $this->createQueryBuilder('r')
            ->select('COUNT(r.id)')
            ->andWhere('r.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->getQuery()
            ->getSingleScalarResult();

        return $count;
    }

    /**
     * The resume path's known-repo map: three fields per row, because streaming full documents
     * to rebuild a hash map is the one avoidable cost at startup (AGENTS.md §4.1's TS
     * equivalent, `KnownRepoSchema`).
     *
     * @return array<int, array{payloadHash: string, firstSeenRunId: string}> keyed by repoId
     */
    public function knownByQuerySlug(string $querySlug): array
    {
        $rows = $this->createQueryBuilder('r')
            ->select('r.repoId AS repoId', 'r.payloadHash AS payloadHash', 'r.firstSeenRunId AS firstSeenRunId')
            ->andWhere('r.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->getQuery()
            ->getArrayResult();

        $known = [];
        foreach ($rows as $row) {
            /** @var array{repoId: int, payloadHash: string, firstSeenRunId: string} $row */
            $known[$row['repoId']] = ['payloadHash' => $row['payloadHash'], 'firstSeenRunId' => $row['firstSeenRunId']];
        }

        return $known;
    }

    /**
     * @return list<DiscoveryRepo>
     */
    public function findByQuerySlug(string $querySlug, int $limit, string $sortField = 'stars', string $sortDirection = 'DESC'): array
    {
        /** @var list<DiscoveryRepo> */
        return $this->createQueryBuilder('r')
            ->andWhere('r.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->orderBy('r.'.$sortField, $sortDirection)
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /**
     * @return list<DiscoveryRepo>
     */
    public function findAllOrdered(int $limit, string $sortField = 'stars', string $sortDirection = 'DESC'): array
    {
        /** @var list<DiscoveryRepo> */
        return $this->createQueryBuilder('r')
            ->orderBy('r.'.$sortField, $sortDirection)
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /** Deletes every row for one query — `--fresh` and `discovery:reset`'s corpus wipe. */
    public function removeByQuerySlug(string $querySlug): int
    {
        return $this->createQueryBuilder('r')
            ->delete()
            ->andWhere('r.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->getQuery()
            ->execute();
    }
}
