<?php

declare(strict_types=1);

namespace App\Discovery\Store;

use App\Discovery\Search\SearchItem;

/**
 * The change signal that gates a `DiscoveryRepo` rewrite (AGENTS.md §4.1: "a window whose result
 * set is byte-identical is not rewritten"). Ported from `store/collections.ts`'s `toDetail`.
 *
 * Deliberately excludes `discoveredVia`/`discoveredAt`: the first is provenance, not content, and
 * unstable by construction (a window over 1000 results contributes its probe items under the
 * parent's query and then subdivides, so a child re-sees those repos under a different query
 * string); the second would make every document look changed on every run.
 *
 * `stars` IS included, unlike a `Repo.content_hash` (which deliberately excludes it to avoid
 * gating expensive re-analysis on star churn) — this hash gates a write whose whole content is
 * that star count.
 */
final class PayloadHash
{
    private function __construct()
    {
    }

    public static function of(SearchItem $item): string
    {
        $topics = $item->topics;
        sort($topics);

        $content = [
            'repo_id' => $item->id,
            'full_name' => $item->fullName,
            'name' => $item->name,
            'owner' => $item->ownerLogin ?? (explode('/', $item->fullName)[0]),
            'description' => $item->description,
            'homepage' => $item->homepage,
            'stars' => $item->stargazersCount,
            'forks' => $item->forksCount,
            'open_issues' => $item->openIssuesCount,
            'language' => $item->language,
            'license' => $item->license,
            'topics' => $topics,
            'archived' => $item->archived,
            'fork' => $item->fork,
            'default_branch' => $item->defaultBranch,
            'created_at' => $item->createdAt,
            'updated_at' => $item->updatedAt,
            'pushed_at' => $item->pushedAt,
        ];

        return substr(hash('sha256', json_encode($content, \JSON_THROW_ON_ERROR)), 0, 32);
    }
}
