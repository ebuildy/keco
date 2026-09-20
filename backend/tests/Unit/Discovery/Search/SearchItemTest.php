<?php

declare(strict_types=1);

namespace App\Tests\Unit\Discovery\Search;

use App\Discovery\Search\InvalidSearchItemException;
use App\Discovery\Search\SearchItem;
use PHPUnit\Framework\TestCase;

final class SearchItemTest extends TestCase
{
    /**
     * @return array<string, mixed>
     */
    private static function valid(): array
    {
        return [
            'id' => 1,
            'full_name' => 'kubernetes/kubectl',
            'name' => 'kubectl',
            'owner' => ['login' => 'kubernetes'],
            'description' => 'The k8s CLI',
            'homepage' => null,
            'stargazers_count' => 100,
            'forks_count' => 10,
            'open_issues_count' => 2,
            'language' => 'Go',
            'license' => ['spdx_id' => 'Apache-2.0'],
            'topics' => ['kubernetes', 'cli'],
            'archived' => false,
            'fork' => false,
            'default_branch' => 'main',
            'created_at' => '2020-01-01T00:00:00Z',
            'updated_at' => '2026-01-01T00:00:00Z',
            'pushed_at' => '2026-01-01T00:00:00Z',
        ];
    }

    public function testParsesAWellFormedItem(): void
    {
        $item = SearchItem::fromArray(self::valid());

        self::assertSame(1, $item->id);
        self::assertSame('kubernetes/kubectl', $item->fullName);
        self::assertSame('kubernetes', $item->ownerLogin);
        self::assertSame('Apache-2.0', $item->license);
        self::assertSame(['kubernetes', 'cli'], $item->topics);
    }

    public function testAcceptsANullOwnerDescriptionAndLicense(): void
    {
        $data = self::valid();
        $data['owner'] = null;
        $data['description'] = null;
        $data['license'] = null;

        $item = SearchItem::fromArray($data);

        self::assertNull($item->ownerLogin);
        self::assertNull($item->description);
        self::assertNull($item->license);
    }

    public function testRejectsAMissingRequiredField(): void
    {
        $data = self::valid();
        unset($data['default_branch']);

        $this->expectException(InvalidSearchItemException::class);
        SearchItem::fromArray($data);
    }

    public function testRejectsATopicsArrayContainingANonString(): void
    {
        $data = self::valid();
        $data['topics'] = ['cli', 42];

        $this->expectException(InvalidSearchItemException::class);
        SearchItem::fromArray($data);
    }

    public function testRejectsAWrongTypeForABooleanField(): void
    {
        $data = self::valid();
        $data['archived'] = 'no';

        $this->expectException(InvalidSearchItemException::class);
        SearchItem::fromArray($data);
    }
}
