# ADR 0003 — The crawler fetches metadata over REST with ETags, not GraphQL

**Date:** 2026-09-05
**Status:** accepted
**Related:** ADR 0001 (CQRS, no database)

## Context

AGENTS.md §4.2 asked the crawler for two things that cannot both hold:

- "GraphQL for bulk metadata (≤100 repos/query — far cheaper against the 5000 points/hour
  budget)"
- "`ETag` / `If-None-Match` on everything: a 304 costs no quota"

GitHub's GraphQL API supports no conditional requests. A GraphQL query always spends points; a
REST 304 spends none.

## Decision

Fetch repo metadata with one conditional REST request per repo, through the existing
`GitHubClient.conditional()`. No GraphQL client is added.

## Consequences

| | first crawl, 30k repos | weekly re-sweep |
|---|---|---|
| GraphQL bulk | ~300 points | ~300 points (no 304s) |
| REST + ETag | 30k points (~6 h) | ~0 points |

The weekly full sweep is the cadence §4 specifies, and REST+ETag is three orders of magnitude
cheaper in that steady state. The cold start is a one-time six hours, and it reuses a client that
already exists and is tested rather than adding an unconditional path that would need its own
quota accounting.

A 304 on `/repos` short-circuits the whole repo — README, tree and releases are not fetched — on
the assumption that GitHub computes the repo ETag over the whole response body, `pushed_at`
included. `REFRESH_AFTER_DAYS = 30` in `seeds/github/fetch.ts` guards that assumption: a stale
entry self-heals within a month rather than going permanently stale.

Revisit if a cold start of the full corpus becomes a routine operation rather than a one-off, or
if GitHub adds conditional requests to GraphQL.
