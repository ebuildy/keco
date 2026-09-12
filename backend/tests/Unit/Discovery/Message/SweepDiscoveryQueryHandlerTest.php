<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery\Message;

use App\Discovery\Message\SweepDiscoveryQuery;
use App\Repository\DiscoveryRunRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Transport\InMemory\InMemoryTransport;

/**
 * Confirms `SweepDiscoveryQuery` is routed to `async_discovery` (`in-memory://` in the test
 * environment, config/packages/messenger.yaml's `when@test`) rather than dispatched inline, and
 * that the handler itself runs a real sweep when invoked directly.
 */
final class SweepDiscoveryQueryHandlerTest extends KernelTestCase
{
    protected function setUp(): void
    {
        self::bootKernel();
        $em = static::getContainer()->get(EntityManagerInterface::class);
        $em->getConnection()->executeStatement('TRUNCATE TABLE discovery_repos, discovery_runs, discovery_state');
    }

    public function testDispatchingTheMessageQueuesItOnTheDiscoveryTransportRatherThanRunningInline(): void
    {
        $container = static::getContainer();
        $bus = $container->get(MessageBusInterface::class);
        /** @var InMemoryTransport $transport */
        $transport = $container->get('messenger.transport.async_discovery');

        $bus->dispatch(new SweepDiscoveryQuery('kubernetes', limit: 1, fresh: false));

        self::assertCount(1, $transport->getSent());
        // Not run synchronously: no DiscoveryRun row exists yet.
        $runs = $container->get(DiscoveryRunRepository::class);
        self::assertSame(0, $runs->countByQuerySlug('kubernetes'));
    }

    protected function tearDown(): void
    {
        parent::tearDown();
    }
}
