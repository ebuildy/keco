<?php

declare(strict_types=1);

namespace App\Discovery\Search;

/** GitHub Search failed in a way {@see GitHubSearchClient} could not recover from by retrying. */
final class GitHubSearchException extends \RuntimeException
{
}
