<?php

declare(strict_types=1);

namespace App\Discovery\Search;

/**
 * One GitHub Search result, validated at the boundary (AGENTS.md §13). Ported from
 * `packages/github/src/search.ts`'s zod `SearchItem` schema.
 *
 * Fields GitHub always sends are required, not defaulted: a guessed `defaultBranch` of `'main'`
 * would silently 404 every README image, and a guessed `false` for `archived` would silently
 * defeat the crawler's skip rule. `owner`, `description`, `homepage`, `language`, `license` and
 * `pushedAt` stay nullable — GitHub genuinely omits or nulls those.
 */
final readonly class SearchItem
{
    /**
     * @param list<string> $topics
     */
    public function __construct(
        public int $id,
        public string $fullName,
        public string $name,
        public ?string $ownerLogin,
        public ?string $description,
        public ?string $homepage,
        public int $stargazersCount,
        public int $forksCount,
        public int $openIssuesCount,
        public ?string $language,
        public ?string $license,
        public array $topics,
        public bool $archived,
        public bool $fork,
        public string $defaultBranch,
        public string $createdAt,
        public string $updatedAt,
        public ?string $pushedAt,
    ) {
    }

    /**
     * @param array<array-key, mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $ownerLogin = null;
        $owner = $data['owner'] ?? null;
        if (\is_array($owner)) {
            $ownerLogin = self::requireString($owner, 'login', 'owner.login');
        }

        $licenseSpdxId = null;
        $license = $data['license'] ?? null;
        if (\is_array($license)) {
            $spdx = $license['spdx_id'] ?? null;
            $licenseSpdxId = \is_string($spdx) ? $spdx : null;
        }

        $topicsRaw = $data['topics'] ?? null;
        if (!\is_array($topicsRaw)) {
            throw InvalidSearchItemException::forField('topics');
        }
        $topics = [];
        foreach (array_values($topicsRaw) as $topic) {
            if (!\is_string($topic)) {
                throw InvalidSearchItemException::forField('topics');
            }
            $topics[] = $topic;
        }

        return new self(
            id: self::requireInt($data, 'id'),
            fullName: self::requireString($data, 'full_name'),
            name: self::requireString($data, 'name'),
            ownerLogin: $ownerLogin,
            description: self::optionalString($data, 'description'),
            homepage: self::optionalString($data, 'homepage'),
            stargazersCount: self::requireInt($data, 'stargazers_count'),
            forksCount: self::requireInt($data, 'forks_count'),
            openIssuesCount: self::requireInt($data, 'open_issues_count'),
            language: self::optionalString($data, 'language'),
            license: $licenseSpdxId,
            topics: $topics,
            archived: self::requireBool($data, 'archived'),
            fork: self::requireBool($data, 'fork'),
            defaultBranch: self::requireString($data, 'default_branch'),
            createdAt: self::requireString($data, 'created_at'),
            updatedAt: self::requireString($data, 'updated_at'),
            pushedAt: self::optionalString($data, 'pushed_at'),
        );
    }

    /**
     * @param array<array-key, mixed> $data
     */
    private static function requireString(array $data, string $key, ?string $label = null): string
    {
        $value = $data[$key] ?? null;
        if (!\is_string($value)) {
            throw InvalidSearchItemException::forField($label ?? $key);
        }

        return $value;
    }

    /**
     * @param array<array-key, mixed> $data
     */
    private static function optionalString(array $data, string $key): ?string
    {
        $value = $data[$key] ?? null;
        if (null === $value) {
            return null;
        }
        if (!\is_string($value)) {
            throw InvalidSearchItemException::forField($key);
        }

        return $value;
    }

    /**
     * @param array<array-key, mixed> $data
     */
    private static function requireInt(array $data, string $key): int
    {
        $value = $data[$key] ?? null;
        if (!\is_int($value)) {
            throw InvalidSearchItemException::forField($key);
        }

        return $value;
    }

    /**
     * @param array<array-key, mixed> $data
     */
    private static function requireBool(array $data, string $key): bool
    {
        $value = $data[$key] ?? null;
        if (!\is_bool($value)) {
            throw InvalidSearchItemException::forField($key);
        }

        return $value;
    }
}
