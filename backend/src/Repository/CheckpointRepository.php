<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\Checkpoint;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<Checkpoint>
 */
class CheckpointRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Checkpoint::class);
    }

    public function save(Checkpoint $checkpoint, bool $flush = true): void
    {
        $this->getEntityManager()->persist($checkpoint);

        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    public function findByConsumerName(string $consumerName): ?Checkpoint
    {
        return $this->find($consumerName);
    }
}
