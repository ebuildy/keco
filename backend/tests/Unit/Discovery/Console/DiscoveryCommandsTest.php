<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery\Console;

use App\Discovery\Console\DiscoveryCountCommand;
use App\Discovery\Console\DiscoveryListCommand;
use App\Discovery\Console\DiscoveryResetCommand;
use App\Discovery\Search\SearchItem;
use App\Discovery\Store\DiscoveryStore;
use App\Discovery\Store\OpenOptions;
use App\Discovery\SystemClock;
use App\Repository\DiscoveryRepoRepository;
use App\Repository\DiscoveryRunRepository;
use App\Repository\DiscoveryStateRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;
use Symfony\Component\Console\Tester\CommandTester;

/**
 * Drives `app:discovery:count|list|reset` the way an operator would — through `CommandTester`,
 * over real Postgres data seeded via `DiscoveryStore` (the same round trip
 * `app:discovery:sweep` itself performs).
 */
final class DiscoveryCommandsTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private DiscoveryRepoRepository $repos;
    private DiscoveryRunRepository $runs;
    private DiscoveryStateRepository $states;

    protected function setUp(): void
    {
        self::bootKernel();
        $container = static::getContainer();

        $this->em = $container->get(EntityManagerInterface::class);
        $this->repos = $container->get(DiscoveryRepoRepository::class);
        $this->runs = $container->get(DiscoveryRunRepository::class);
        $this->states = $container->get(DiscoveryStateRepository::class);

        $this->em->getConnection()->executeStatement('TRUNCATE TABLE discovery_repos, discovery_runs, discovery_state');
    }

    private function seedOneRepo(string $query, int $stars): void
    {
        $store = DiscoveryStore::open(
            $this->em,
            $this->repos,
            $this->runs,
            $this->states,
            new SystemClock(),
            $query,
            new OpenOptions(now: new \DateTimeImmutable('2026-08-02T00:00:00Z')),
        );
        $item = SearchItem::fromArray([
            'id' => $stars,
            'full_name' => "org/{$query}-{$stars}",
            'name' => "{$query}-{$stars}",
            'owner' => ['login' => 'org'],
            'description' => null,
            'homepage' => null,
            'stargazers_count' => $stars,
            'forks_count' => 0,
            'open_issues_count' => 0,
            'language' => 'Go',
            'license' => null,
            'topics' => [],
            'archived' => false,
            'fork' => false,
            'default_branch' => 'main',
            'created_at' => '2020-01-01T00:00:00Z',
            'updated_at' => '2020-01-01T00:00:00Z',
            'pushed_at' => null,
        ]);
        $store->record($item, 'q', new \DateTimeImmutable());
        $store->flush();
        $store->finishRun('complete');
    }

    public function testCountCommandReportsTheSeededQuery(): void
    {
        $this->seedOneRepo('kubernetes', 10);
        $tester = new CommandTester(static::getContainer()->get(DiscoveryCountCommand::class));

        $tester->execute([]);

        $tester->assertCommandIsSuccessful();
        self::assertStringContainsString('kubernetes', $tester->getDisplay());
    }

    public function testCountCommandJsonOutputIsOneLinePerQuery(): void
    {
        $this->seedOneRepo('kubernetes', 10);
        $tester = new CommandTester(static::getContainer()->get(DiscoveryCountCommand::class));

        $tester->execute(['--json' => true]);

        $tester->assertCommandIsSuccessful();
        $lines = array_values(array_filter(explode("\n", trim($tester->getDisplay()))));
        self::assertCount(1, $lines);
        /** @var array{query_slug: string, repos: int} $decoded */
        $decoded = json_decode($lines[0], true, flags: \JSON_THROW_ON_ERROR);
        self::assertSame('kubernetes', $decoded['query_slug']);
        self::assertSame(1, $decoded['repos']);
    }

    public function testListCommandDefaultsToRuns(): void
    {
        $this->seedOneRepo('kubernetes', 10);
        $tester = new CommandTester(static::getContainer()->get(DiscoveryListCommand::class));

        $tester->execute([]);

        $tester->assertCommandIsSuccessful();
        self::assertStringContainsString('complete', $tester->getDisplay());
    }

    public function testListCommandRepos(): void
    {
        $this->seedOneRepo('kubernetes', 42);
        $tester = new CommandTester(static::getContainer()->get(DiscoveryListCommand::class));

        $tester->execute(['target' => 'repos']);

        $tester->assertCommandIsSuccessful();
        self::assertStringContainsString('kubernetes-42', $tester->getDisplay());
    }

    public function testListCommandRejectsAnUnknownTarget(): void
    {
        $tester = new CommandTester(static::getContainer()->get(DiscoveryListCommand::class));

        $exitCode = $tester->execute(['target' => 'bogus']);

        self::assertSame(2, $exitCode);
    }

    public function testResetCommandRefusesWithNoTarget(): void
    {
        $tester = new CommandTester(static::getContainer()->get(DiscoveryResetCommand::class));

        $exitCode = $tester->execute([]);

        self::assertNotSame(0, $exitCode);
        self::assertStringContainsString('--query', $tester->getDisplay());
    }

    public function testResetCommandWithYesDeletesTheCorpusAndKeepsRunHistory(): void
    {
        $this->seedOneRepo('kubernetes', 10);
        $tester = new CommandTester(static::getContainer()->get(DiscoveryResetCommand::class));

        $tester->execute(['--query' => 'kubernetes', '--yes' => true]);

        $tester->assertCommandIsSuccessful();
        self::assertSame(0, $this->repos->countByQuerySlug('kubernetes'));
        self::assertSame(1, $this->runs->countByQuerySlug('kubernetes'));
    }

    public function testResetCommandWithoutYesPromptsAndDefaultsToAborting(): void
    {
        $this->seedOneRepo('kubernetes', 10);
        $tester = new CommandTester(static::getContainer()->get(DiscoveryResetCommand::class));

        // No input provided; ConfirmationQuestion defaults to false (the command's own default).
        $tester->setInputs(['']);
        $tester->execute(['--query' => 'kubernetes']);

        $tester->assertCommandIsSuccessful();
        self::assertSame(1, $this->repos->countByQuerySlug('kubernetes'));
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        unset($this->em, $this->repos, $this->runs, $this->states);
    }
}
