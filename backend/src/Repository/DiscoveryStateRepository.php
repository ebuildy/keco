<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\DiscoveryState;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<DiscoveryState>
 */
class DiscoveryStateRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, DiscoveryState::class);
    }

    public function save(DiscoveryState $state, bool $flush = false): void
    {
        $this->getEntityManager()->persist($state);
        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    public function findByQuerySlug(string $querySlug): ?DiscoveryState
    {
        return $this->find($querySlug);
    }

    /**
     * @return list<DiscoveryState>
     */
    public function findAllOrderedBySlug(): array
    {
        /** @var list<DiscoveryState> */
        return $this->createQueryBuilder('s')
            ->orderBy('s.querySlug', 'ASC')
            ->getQuery()
            ->getResult();
    }

    /** `--fresh` / `discovery:reset`'s state wipe — at most one row, but expressed as a bulk delete. */
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
