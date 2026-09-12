<?php

declare(strict_types=1);

namespace App\Repository;

use App\Entity\JournalEvent;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;
use Symfony\Component\Uid\Ulid;

/**
 * @extends ServiceEntityRepository<JournalEvent>
 */
class JournalEventRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, JournalEvent::class);
    }

    public function save(JournalEvent $event, bool $flush = true): void
    {
        $this->getEntityManager()->persist($event);

        if ($flush) {
            $this->getEntityManager()->flush();
        }
    }

    /**
     * Indexed range read: every event after `$after` (exclusive), oldest first, capped at
     * `$limit`. `$after === null` reads from the very start of the journal. Never a full scan
     * (AGENTS.md §3, §14): the WHERE clause and ORDER BY both hit the primary key index.
     *
     * @return list<JournalEvent>
     */
    public function findSince(?Ulid $after, int $limit): array
    {
        $qb = $this->createQueryBuilder('e')
            ->orderBy('e.id', 'ASC')
            ->setMaxResults($limit);

        if (null !== $after) {
            $qb->andWhere('e.id > :after')->setParameter('after', $after, 'ulid');
        }

        /** @var list<JournalEvent> */
        return $qb->getQuery()->getResult();
    }
}
