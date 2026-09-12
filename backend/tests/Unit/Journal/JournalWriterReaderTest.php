<?php

declare(strict_types=1);

namespace App\Tests\Unit\Journal;

use App\Journal\JournalReader;
use App\Journal\JournalWriter;
use App\Repository\JournalEventRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Uid\Ulid;

final class JournalWriterReaderTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private JournalWriter $writer;
    private JournalReader $reader;

    protected function setUp(): void
    {
        self::bootKernel();

        $container = static::getContainer();
        $this->em = $container->get(EntityManagerInterface::class);
        $this->writer = new JournalWriter($container->get(JournalEventRepository::class));
        $this->reader = new JournalReader($container->get(JournalEventRepository::class));

        // journal_events is append-only in production; truncating between tests is the one
        // deliberate exception, so each test starts from a clean, known journal.
        $this->em->getConnection()->executeStatement('TRUNCATE TABLE journal_events');
    }

    public function testAppendPersistsAnImmutableEvent(): void
    {
        $event = $this->writer->append('RepoFetched', 'kubernetes/kubectl', ['changed' => true]);

        $this->em->clear();
        $reloaded = $this->em->getRepository(\App\Entity\JournalEvent::class)->find($event->getId());

        self::assertNotNull($reloaded);
        self::assertSame('RepoFetched', $reloaded->getType());
        self::assertSame('kubernetes/kubectl', $reloaded->getRepo());
        self::assertSame(['changed' => true], $reloaded->getPayload());
    }

    public function testAppendAllowsANullRepo(): void
    {
        $event = $this->writer->append('RepoSkipped', null, ['reason' => 'fork']);

        self::assertNull($event->getRepo());
    }

    public function testReadSinceReturnsEventsOldestFirst(): void
    {
        $first = $this->writer->append('RepoFetched', 'a/a', []);
        $second = $this->writer->append('RepoFetched', 'b/b', []);
        $third = $this->writer->append('RepoFetched', 'c/c', []);

        $events = $this->reader->readSince(null, 10);

        self::assertCount(3, $events);
        self::assertTrue($first->getId()->equals($events[0]->getId()));
        self::assertTrue($second->getId()->equals($events[1]->getId()));
        self::assertTrue($third->getId()->equals($events[2]->getId()));
    }

    public function testReadSinceIsExclusiveOfTheCheckpoint(): void
    {
        $first = $this->writer->append('RepoFetched', 'a/a', []);
        $second = $this->writer->append('RepoFetched', 'b/b', []);

        $events = $this->reader->readSince($first->getId(), 10);

        self::assertCount(1, $events);
        self::assertTrue($second->getId()->equals($events[0]->getId()));
    }

    public function testReadSinceRespectsTheLimitWithoutScanningPastIt(): void
    {
        for ($i = 0; $i < 5; ++$i) {
            $this->writer->append('RepoFetched', "owner/repo-{$i}", []);
        }

        $events = $this->reader->readSince(null, 2);

        self::assertCount(2, $events);
    }

    public function testReadSinceWithNoNewEventsReturnsEmpty(): void
    {
        $last = $this->writer->append('RepoFetched', 'a/a', []);

        $events = $this->reader->readSince($last->getId(), 10);

        self::assertSame([], $events);
    }

    public function testReadSinceRejectsANonPositiveLimit(): void
    {
        $this->expectException(\InvalidArgumentException::class);

        $this->reader->readSince(null, 0);
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        unset($this->em, $this->writer, $this->reader);
    }
}
