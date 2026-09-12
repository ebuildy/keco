<?php

declare(strict_types=1);

namespace App\Discovery;

/**
 * `--query` is free text that becomes part of a document id, so it is a validation surface as
 * much as a naming one. Ported from `store/collections.ts`'s `slugifyQuery`/`repoDocumentId`.
 *
 * Lowercase, collapse every run of non-alphanumerics to one `-`, trim, truncate; anything left
 * with no alphanumerics at all is refused.
 *
 * Deliberately lossy, so two queries CAN share one namespace — `kubernetes operator` and
 * `kubernetes-operator` both give `kubernetes-operator`. Accepted: colliding queries are
 * near-identical searches whose union is still a valid candidate corpus.
 */
final class QuerySlug
{
    /**
     * Long enough for any real keyword, short enough to keep a composite entity id well inside
     * every backend's key length limit.
     */
    private const MAX_LENGTH = 100;

    private function __construct()
    {
    }

    public static function of(string $query): string
    {
        $slug = strtolower($query);
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');
        $slug = substr($slug, 0, self::MAX_LENGTH);
        $slug = rtrim($slug, '-');

        if ('' === $slug) {
            throw new \InvalidArgumentException(\sprintf(
                'discovery query "%s" has no ASCII alphanumeric characters, so it has no entity namespace. Pass a keyword such as --query kubernetes.',
                $query,
            ));
        }

        return $slug;
    }

    /**
     * Underscore, never a colon: `DiscoveryRepo::id` is `[A-Za-z0-9_-]` only. Slugs contain no
     * underscores and repo ids are numeric, so `{slug}_{id}` cannot collide between two queries.
     */
    public static function repoId(string $querySlug, int $repoId): string
    {
        return \sprintf('%s_%d', $querySlug, $repoId);
    }
}
