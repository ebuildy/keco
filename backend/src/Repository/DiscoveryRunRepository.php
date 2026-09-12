<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\DiscoveryRun;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<DiscoveryRun>
 */
class DiscoveryRunRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, DiscoveryRun::class);
    }

    public function save(DiscoveryRun $run, bool $flush = false): void
    {
        $this->getEntityManager()->persist($run);
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

    public function findLatestByQuerySlug(string $querySlug): ?DiscoveryRun
    {
        /** @var DiscoveryRun|null */
        return $this->createQueryBuilder('r')
            ->andWhere('r.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->orderBy('r.startedAt', 'DESC')
            ->setMaxResults(1)
            ->getQuery()
            ->getOneOrNullResult();
    }

    /**
     * @return list<DiscoveryRun>
     */
    public function findByQuerySlug(string $querySlug, int $limit, string $sortField = 'startedAt', string $sortDirection = 'DESC'): array
    {
        /** @var list<DiscoveryRun> */
        return $this->createQueryBuilder('r')
            ->andWhere('r.querySlug = :slug')
            ->setParameter('slug', $querySlug)
            ->orderBy('r.'.$sortField, $sortDirection)
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /**
     * @return list<DiscoveryRun>
     */
    public function findAllOrdered(int $limit, string $sortField = 'startedAt', string $sortDirection = 'DESC'): array
    {
        /** @var list<DiscoveryRun> */
        return $this->createQueryBuilder('r')
            ->orderBy('r.'.$sortField, $sortDirection)
            ->setMaxResults($limit)
            ->getQuery()
            ->getResult();
    }

    /** Deletes every run row for one query — `--include-runs` only; never the default path. */
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
