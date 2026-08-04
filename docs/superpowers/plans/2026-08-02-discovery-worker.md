# Discovery Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a discovery worker that enumerates every GitHub repository matching a keyword (default `kubernetes`) across the whole corpus, writing `repos-full-list.yaml` plus one detail YAML per repo in a two-letter bucket hierarchy, with a resumable sweep and a progress bar.

**Architecture:** A fourth worker under `apps/workers/src/discovery/`, sitting before the crawler. GitHub Search caps every query at 1000 results, so a query is split into star bands that subdivide on demand by creation date whenever a window reports more than 1000 hits. All state goes through the `@keco/cache` `Storage` port under a `discovery/` prefix; the pure modules (`windows`, `store`) hold the logic and are unit-tested without a network.

**Tech Stack:** TypeScript (ESM, `strict`), Node 24, pnpm workspaces, vitest, zod for boundary validation, `yaml` for serialisation, Octokit for GitHub Search, pino for structured logs, mise as the task runner.

**Reference:** [the design](../specs/2026-08-02-discovery-worker-design.md). Read AGENTS.md §3 (the cache), §4 (workers) and §13 (conventions) before starting.

---

## Two corrections to the spec, applied by this plan

Both were found while writing the plan. Task 8 updates the spec document itself so the two agree.

1. **`_state.json` needs a persisted queue.** The spec stores only `completed_windows`. That loses work: when a window is subdivided, its children exist only in memory, and marking the parent complete means a resume never regenerates them. This plan adds `pending_windows` — the live queue, serialised.

2. **The rewrite-skip rate will be far lower than the spec's example suggests.** `payload_hash` covers `stars`, which churn constantly, so a weekly sweep rewrites most files rather than a few hundred. This is correct behaviour — the data really did change — but the optimisation mainly pays off on same-day re-runs and on resumes, not on weekly sweeps. Keeping stars in the hash is deliberate: excluding them would leave the written file claiming a star count the search no longer reports.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cache/src/keys.ts` | **modify** — add `discoveryKeys`, including the bucket path. Every write-model key lives here; building paths outside `packages/cache` is the §14 anti-pattern |
| `packages/cache/src/keys.test.ts` | **create** — bucket path encoding |
| `packages/github/src/search.ts` | **create** — `SearchItem`/`SearchPage` zod schemas, `RatePacer`, `SearchClient` |
| `packages/github/src/search.test.ts` | **create** — pacing, retries, parsing |
| `packages/github/src/index.ts` | **modify** — re-export `./search` |
| `packages/github/package.json` | **modify** — add `zod` |
| `apps/workers/src/discovery/windows.ts` | **create** — star bands, window splitting, query rendering (pure) |
| `apps/workers/src/discovery/windows.test.ts` | **create** |
| `apps/workers/src/discovery/store.ts` | **create** — detail projection, hashing, full list, hashes, resume state |
| `apps/workers/src/discovery/store.test.ts` | **create** |
| `apps/workers/src/lib/progress.ts` | **create** — TTY bar on stderr / non-TTY periodic logging |
| `apps/workers/src/lib/progress.test.ts` | **create** |
| `apps/workers/src/discovery/index.ts` | **create** — CLI and the orchestration loop |
| `apps/workers/package.json` | **modify** — `discovery` script, `yaml` dependency |
| `eslint.config.mjs` | **modify** — add `discovery/**` to the no-`@keco/search` boundary |
| `mise.toml` | **modify** — `mise run discovery` |

The worker owns no path construction and no HTTP. It composes `keys` (paths), `search` (HTTP), `windows` (query algebra) and `store` (persistence).

---

## Task 1: Discovery cache keys

Every key in the write model is declared in `packages/cache/src/keys.ts`. The bucket path goes here rather than in the worker, because §14 names `path.join` outside `packages/cache` as a thing that has to be undone when the S3 adapter lands.

**Files:**
- Modify: `packages/cache/src/keys.ts`
- Test: `packages/cache/src/keys.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/cache/src/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { discoveryKeys } from './keys';

describe('discoveryKeys', () => {
  it('names the two shared artifacts', () => {
    expect(discoveryKeys.fullList).toBe('discovery/repos-full-list.yaml');
    expect(discoveryKeys.hashes).toBe('discovery/_hashes.json');
    expect(discoveryKeys.state).toBe('discovery/_state.json');
  });

  it('buckets a repo by the first two letters of its owner', () => {
    expect(discoveryKeys.detail('ahmetb/kubectx')).toBe(
      'discovery/a/h/repo-details-ahmetb__kubectx.yaml',
    );
    expect(discoveryKeys.detail('kubernetes-sigs/krew')).toBe(
      'discovery/k/u/repo-details-kubernetes-sigs__krew.yaml',
    );
  });

  it('pads the bucket when the owner is a single character', () => {
    expect(discoveryKeys.detail('x/y')).toBe('discovery/x/_/repo-details-x__y.yaml');
  });

  it('lowercases only the bucket, preserving the real name in the filename', () => {
    expect(discoveryKeys.detail('Foo/Bar')).toBe('discovery/f/o/repo-details-Foo__Bar.yaml');
  });

  it('replaces characters that are unsafe as a directory name', () => {
    // A leading dot would make a hidden directory; a digit is fine.
    expect(discoveryKeys.detail('.github/example')).toBe(
      'discovery/_/g/repo-details-.github__example.yaml',
    );
    expect(discoveryKeys.detail('9gag/thing')).toBe('discovery/9/g/repo-details-9gag__thing.yaml');
  });

  it('rejects anything that is not owner/repo', () => {
    expect(() => discoveryKeys.detail('kubectx')).toThrow(/owner\/repo/);
    expect(() => discoveryKeys.detail('/kubectx')).toThrow(/owner\/repo/);
    expect(() => discoveryKeys.detail('ahmetb/')).toThrow(/owner\/repo/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/cache/src/keys.test.ts`
Expected: FAIL — `discoveryKeys` is not exported from `./keys`.

- [ ] **Step 3: Implement**

Append to `packages/cache/src/keys.ts`:

```ts
/**
 * Discovery output (design 2026-08-02). Two letter buckets keep any one directory to a few
 * thousand entries — which matters on a filesystem and matters more once this is object
 * storage, where a prefix listing is billed per request.
 *
 * Only the bucket is lowercased. The filename preserves the real casing of owner/repo,
 * because GitHub names are case-sensitive in principle. Two repos differing only by case
 * would collide on a case-insensitive filesystem; that is an accepted limitation, and
 * neither name is lost from repos-full-list.yaml.
 */
const bucketChar = (char: string | undefined): string =>
  char !== undefined && /[a-z0-9]/.test(char) ? char : '_';

export const discoveryKeys = {
  fullList: 'discovery/repos-full-list.yaml',
  hashes: 'discovery/_hashes.json',
  state: 'discovery/_state.json',
  detail(repo: string): string {
    const slash = repo.indexOf('/');
    if (slash <= 0 || slash === repo.length - 1) {
      throw new Error(`expected owner/repo, got "${repo}"`);
    }
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);
    const lower = owner.toLowerCase();
    return `discovery/${bucketChar(lower[0])}/${bucketChar(lower[1])}/repo-details-${owner}__${name}.yaml`;
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/cache/src/keys.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cache/src/keys.ts packages/cache/src/keys.test.ts
git commit -m "feat(cache): discovery keys and letter-bucket detail paths"
```

---

## Task 2: Search client

GitHub Search has its own rate budget — about 30 requests/minute authenticated — entirely separate from the 5000 points/hour REST budget that `QuotaGovernor` splits between crawler and analyzer. So this client carries its own pacer and never touches `QuotaGovernor`.

`SearchClient` takes a transport function rather than an `Octokit` instance, so every test runs without a network.

**Files:**
- Create: `packages/github/src/search.ts`
- Create: `packages/github/src/search.test.ts`
- Modify: `packages/github/src/index.ts`
- Modify: `packages/github/package.json`

- [ ] **Step 1: Add the zod dependency**

Edit `packages/github/package.json`, adding `zod` to `dependencies` so it reads:

```json
  "dependencies": {
    "@keco/core": "workspace:*",
    "@octokit/graphql": "^9.0.4",
    "@octokit/rest": "^22.0.1",
    "zod": "^4.4.3"
  },
```

Then run: `pnpm install`
Expected: completes, `packages/github/node_modules/zod` exists.

- [ ] **Step 2: Write the failing test**

Create `packages/github/src/search.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RatePacer, SearchClient } from './search';

/** One well-formed search item; tests override only the fields they care about. */
const item = (overrides: Record<string, unknown> = {}) => ({
  id: 20038725,
  full_name: 'ahmetb/kubectx',
  name: 'kubectx',
  owner: { login: 'ahmetb' },
  description: 'Faster way to switch between clusters',
  homepage: 'https://kubectx.dev',
  stargazers_count: 18234,
  forks_count: 1180,
  open_issues_count: 41,
  language: 'Go',
  license: { spdx_id: 'Apache-2.0' },
  topics: ['kubernetes', 'kubectl'],
  archived: false,
  fork: false,
  default_branch: 'master',
  created_at: '2014-05-22T12:00:00Z',
  updated_at: '2026-07-20T08:11:00Z',
  pushed_at: '2026-07-14T19:02:00Z',
  ...overrides,
});

/** A fake clock whose sleep advances it, so pacing is testable without real time. */
const fakeClock = () => {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (delay: number) => {
      ms += delay;
    },
    get elapsed() {
      return ms;
    },
  };
};

describe('RatePacer', () => {
  it('spaces calls by the minimum interval', async () => {
    const clock = fakeClock();
    const pacer = new RatePacer(2000, clock.now, clock.sleep);

    await pacer.wait();
    expect(clock.elapsed).toBe(0); // the first call never waits

    await pacer.wait();
    expect(clock.elapsed).toBe(2000);

    await pacer.wait();
    expect(clock.elapsed).toBe(4000);
  });

  it('does not wait when the caller was already slow', async () => {
    const clock = fakeClock();
    const pacer = new RatePacer(2000, clock.now, clock.sleep);

    await pacer.wait();
    await clock.sleep(9000); // caller spent 9s doing other work
    await pacer.wait();

    expect(clock.elapsed).toBe(9000); // no extra sleep was added
  });
});

describe('SearchClient', () => {
  it('parses a page and drops fields we do not model', async () => {
    const transport = vi.fn().mockResolvedValue({
      total_count: 1,
      incomplete_results: false,
      items: [item({ assignees_url: 'https://api.github.com/…' })],
    });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    const page = await client.page('kubernetes stars:>5000', 1);

    expect(page.total_count).toBe(1);
    expect(page.items[0]!.full_name).toBe('ahmetb/kubectx');
    expect(page.items[0]).not.toHaveProperty('assignees_url');
    expect(transport).toHaveBeenCalledWith({
      q: 'kubernetes stars:>5000',
      per_page: 100,
      page: 1,
    });
  });

  it('tolerates the nulls GitHub really returns', async () => {
    const transport = vi.fn().mockResolvedValue({
      total_count: 1,
      incomplete_results: false,
      items: [item({ description: null, license: null, language: null, homepage: null })],
    });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    const page = await client.page('kubernetes', 1);

    expect(page.items[0]!.license).toBeNull();
    expect(page.items[0]!.description).toBeNull();
  });

  it('retries a 403 and honours retry-after', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), {
      status: 403,
      response: { headers: { 'retry-after': '7' } },
    });
    const transport = vi
      .fn()
      .mockRejectedValueOnce(throttled)
      .mockResolvedValue({ total_count: 0, incomplete_results: false, items: [] });

    const client = new SearchClient(transport, {
      minIntervalMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    await client.page('kubernetes', 1);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(clock.elapsed).toBe(7000); // retry-after wins over exponential backoff
  });

  it('gives up after maxRetries', async () => {
    const clock = fakeClock();
    const throttled = Object.assign(new Error('rate limited'), { status: 429 });
    const transport = vi.fn().mockRejectedValue(throttled);
    const client = new SearchClient(transport, {
      minIntervalMs: 0,
      maxRetries: 2,
      now: clock.now,
      sleep: clock.sleep,
    });

    await expect(client.page('kubernetes', 1)).rejects.toThrow('rate limited');
    expect(transport).toHaveBeenCalledTimes(3); // the first try plus two retries
  });

  it('does not retry a malformed payload', async () => {
    const transport = vi.fn().mockResolvedValue({ total_count: 'lots', items: [] });
    const client = new SearchClient(transport, { minIntervalMs: 0 });

    await expect(client.page('kubernetes', 1)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/github/src/search.test.ts`
Expected: FAIL — cannot resolve `./search`.

- [ ] **Step 4: Implement**

Create `packages/github/src/search.ts`:

```ts
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { backoffMs } from './quota';

/**
 * GitHub Search for the discovery worker (design 2026-08-02).
 *
 * Search has its own budget — roughly 30 requests/minute authenticated — separate from the
 * 5000 points/hour REST budget that QuotaGovernor splits between crawler and analyzer
 * (AGENTS.md §4.2). So this client paces itself and deliberately does not touch the governor.
 *
 * The transport is injected rather than an Octokit instance being constructed inline, so the
 * whole retry and pacing story is testable without a network.
 */

/** Authenticated search allows ~30 req/min; one every two seconds stays under it. */
export const GITHUB_SEARCH_MIN_INTERVAL_MS = 2_000;

/**
 * Only the fields discovery records. Validated at the boundary (§13) — GitHub returns ~80
 * more, most of them URL templates, and none of them belong in the detail document.
 */
export const SearchItem = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }).nullish(),
  description: z.string().nullish(),
  homepage: z.string().nullish(),
  stargazers_count: z.number().default(0),
  forks_count: z.number().default(0),
  open_issues_count: z.number().default(0),
  language: z.string().nullish(),
  license: z.object({ spdx_id: z.string().nullish() }).nullish(),
  topics: z.array(z.string()).default([]),
  archived: z.boolean().default(false),
  fork: z.boolean().default(false),
  default_branch: z.string().default('main'),
  created_at: z.string(),
  updated_at: z.string(),
  pushed_at: z.string().nullish(),
});
export type SearchItem = z.infer<typeof SearchItem>;

export const SearchPage = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean().default(false),
  items: z.array(SearchItem),
});
export type SearchPage = z.infer<typeof SearchPage>;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimum-interval pacer. Steady spacing rather than bursts: GitHub's secondary rate
 * limits punish bursts even when the primary budget still has room.
 */
export class RatePacer {
  private nextAllowedAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  async wait(): Promise<void> {
    const delay = this.nextAllowedAt - this.now();
    if (delay > 0) await this.sleep(delay);
    this.nextAllowedAt = this.now() + this.minIntervalMs;
  }
}

export type SearchTransport = (params: {
  q: string;
  per_page: number;
  page: number;
}) => Promise<unknown>;

export type SearchClientOptions = {
  minIntervalMs?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class SearchClient {
  private readonly pacer: RatePacer;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly transport: SearchTransport,
    options: SearchClientOptions = {},
  ) {
    const now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.pacer = new RatePacer(
      options.minIntervalMs ?? GITHUB_SEARCH_MIN_INTERVAL_MS,
      now,
      this.sleep,
    );
    this.maxRetries = options.maxRetries ?? 5;
  }

  static fromToken(token: string, options: SearchClientOptions = {}): SearchClient {
    const octokit = new Octokit({ auth: token, userAgent: 'keco' });
    return new SearchClient(
      async (params) => (await octokit.rest.search.repos(params)).data,
      options,
    );
  }

  /**
   * One page of results. Page 1 is also the probe: its `total_count` is what decides
   * whether the window needs subdividing, and its items are real results either way.
   */
  async page(query: string, page: number, perPage = 100): Promise<SearchPage> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pacer.wait();
      try {
        return SearchPage.parse(await this.transport({ q: query, per_page: perPage, page }));
      } catch (error) {
        // Only throttling is retried. A schema failure means GitHub changed shape, and
        // retrying it would just burn the budget five times before failing anyway.
        const status = (error as { status?: number }).status;
        if ((status === 403 || status === 429) && attempt < this.maxRetries) {
          const retryAfter = Number(
            (error as { response?: { headers?: Record<string, string> } }).response?.headers?.[
              'retry-after'
            ] ?? 0,
          );
          await this.sleep(backoffMs(attempt, retryAfter || null));
          continue;
        }
        throw error;
      }
    }
  }
}
```

- [ ] **Step 5: Re-export from the package entry point**

Edit `packages/github/src/index.ts`, adding this next to the existing `export * from './quota';`:

```ts
export * from './search';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run packages/github/src/search.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/github/src/search.ts packages/github/src/search.test.ts \
        packages/github/src/index.ts packages/github/package.json pnpm-lock.yaml
git commit -m "feat(github): search client with its own rate pacer and retry"
```

---

## Task 3: Search windows

Pure query algebra: no network, no cache, no clock beyond an injected `now`. This is where "reach the whole corpus" actually lives.

Windows must be **stable across runs** — a resumed sweep matches `completed_windows` by query string, so calendar-aligned boundaries are required. Bisecting an interval that ends at "today" would produce different queries every day and silently invalidate resume state.

**Files:**
- Create: `apps/workers/src/discovery/windows.ts`
- Create: `apps/workers/src/discovery/windows.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/workers/src/discovery/windows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STAR_BANDS, initialWindows, queryOf, split, type Window } from './windows';

const at = (iso: string) => new Date(iso);

describe('STAR_BANDS', () => {
  it('covers every star count from 0 upward with no gap and no overlap', () => {
    // Every band is either ">N" (the open top) or "A..B" or a bare "N".
    const bounds = STAR_BANDS.map((band) => {
      if (band.startsWith('>')) return { lo: Number(band.slice(1)) + 1, hi: Infinity };
      if (band.includes('..')) {
        const [lo, hi] = band.split('..');
        return { lo: Number(lo), hi: Number(hi) };
      }
      return { lo: Number(band), hi: Number(band) };
    }).sort((a, b) => a.lo - b.lo);

    expect(bounds[0]!.lo).toBe(0);
    expect(bounds.at(-1)!.hi).toBe(Infinity);
    for (let i = 1; i < bounds.length; i += 1) {
      expect(bounds[i]!.lo).toBe(bounds[i - 1]!.hi + 1);
    }
  });
});

describe('initialWindows', () => {
  it('starts with one unconstrained window per star band', () => {
    const windows = initialWindows('kubernetes');
    expect(windows).toHaveLength(STAR_BANDS.length);
    expect(windows.every((w) => w.created === null)).toBe(true);
    expect(queryOf(windows[0]!)).toBe('kubernetes stars:>5000');
  });
});

describe('split', () => {
  const band = (stars: string): Window => ({ base: 'kubernetes', stars, created: null });

  it('splits an unconstrained band into a pre-2014 bucket plus one window per year', () => {
    const parts = split(band('0'), at('2026-08-02T00:00:00Z'));

    expect(queryOf(parts[0]!)).toBe('kubernetes stars:0 created:2008-01-01..2013-12-31');
    expect(queryOf(parts[1]!)).toBe('kubernetes stars:0 created:2014-01-01..2014-12-31');
    expect(queryOf(parts.at(-1)!)).toBe('kubernetes stars:0 created:2026-01-01..2026-12-31');
    expect(parts).toHaveLength(1 + (2026 - 2013));
  });

  it('splits the pre-2014 bucket into its individual years', () => {
    const [multi] = split(band('0'), at('2026-08-02T00:00:00Z'));
    const parts = split(multi!, at('2026-08-02T00:00:00Z'));

    expect(parts).toHaveLength(6);
    expect(queryOf(parts[0]!)).toBe('kubernetes stars:0 created:2008-01-01..2008-12-31');
    expect(queryOf(parts.at(-1)!)).toBe('kubernetes stars:0 created:2013-01-01..2013-12-31');
  });

  it('splits a year into four calendar quarters', () => {
    const year: Window = { base: 'kubernetes', stars: '0', created: { kind: 'year', year: 2020 } };
    const parts = split(year);

    expect(parts.map(queryOf)).toEqual([
      'kubernetes stars:0 created:2020-01-01..2020-03-31',
      'kubernetes stars:0 created:2020-04-01..2020-06-30',
      'kubernetes stars:0 created:2020-07-01..2020-09-30',
      'kubernetes stars:0 created:2020-10-01..2020-12-31',
    ]);
  });

  it('splits a quarter into its three months', () => {
    const quarter: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'quarter', year: 2020, quarter: 1 },
    };

    expect(split(quarter).map(queryOf)).toEqual([
      'kubernetes stars:0 created:2020-01-01..2020-01-31',
      'kubernetes stars:0 created:2020-02-01..2020-02-29',
      'kubernetes stars:0 created:2020-03-01..2020-03-31',
    ]);
  });

  it('splits a month into days, respecting leap years', () => {
    const leap: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'month', year: 2020, month: 2 },
    };
    const common: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'month', year: 2021, month: 2 },
    };

    expect(split(leap)).toHaveLength(29);
    expect(split(common)).toHaveLength(28);
    expect(queryOf(split(leap).at(-1)!)).toBe('kubernetes stars:0 created:2020-02-29');
  });

  it('cannot split a single day — that is the floor', () => {
    const day: Window = {
      base: 'kubernetes',
      stars: '0',
      created: { kind: 'day', date: '2020-02-29' },
    };
    expect(split(day)).toEqual([]);
  });

  it('produces the same queries on every run, so resume state stays valid', () => {
    const monday = split(initialWindows('kubernetes')[5]!, at('2026-08-02T00:00:00Z'));
    const tuesday = split(initialWindows('kubernetes')[5]!, at('2026-08-03T11:00:00Z'));
    expect(monday.map(queryOf)).toEqual(tuesday.map(queryOf));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/windows.test.ts`
Expected: FAIL — cannot resolve `./windows`.

- [ ] **Step 3: Implement**

Create `apps/workers/src/discovery/windows.ts`:

```ts
/**
 * Search windows (design 2026-08-02).
 *
 * GitHub Search returns at most 1000 results per query, so a keyword is split into star
 * bands, and any band still over 1000 is subdivided by creation date until it fits.
 *
 * Boundaries are calendar-aligned rather than bisected, and that is load-bearing: a resumed
 * sweep matches completed windows by query string, so a window whose bounds shifted with the
 * current date would invalidate every resume. `created:2020-01-01..2020-03-31` means the same
 * thing tomorrow.
 *
 * Pure: no network, no cache, no ambient clock.
 */

/** Kubernetes launched in 2014; GitHub opened in 2008. Everything older is one bucket. */
export const GITHUB_EPOCH_YEAR = 2008;
export const EARLY_YEARS_END = 2013;

/**
 * Coarse at the top where repos are few, fine at the bottom where the long tail lives.
 * Must remain contiguous from 0 upward — windows.test.ts asserts it.
 */
export const STAR_BANDS = [
  '>5000',
  '1000..5000',
  '500..999',
  '200..499',
  '100..199',
  '50..99',
  '20..49',
  '10..19',
  '5..9',
  '3..4',
  '2',
  '1',
  '0',
] as const;

export type Created =
  | { kind: 'years'; from: number; to: number }
  | { kind: 'year'; year: number }
  | { kind: 'quarter'; year: number; quarter: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'day'; date: string };

export type Window = {
  base: string;
  stars: string;
  created: Created | null;
};

export function initialWindows(base: string): Window[] {
  return STAR_BANDS.map((stars) => ({ base, stars, created: null }));
}

/** Sub-windows one level finer. An empty result means the floor: a single day. */
export function split(window: Window, now = new Date()): Window[] {
  return splitCreated(window.created, now.getUTCFullYear()).map((created) => ({
    ...window,
    created,
  }));
}

function splitCreated(created: Created | null, currentYear: number): Created[] {
  if (created === null) {
    const out: Created[] = [{ kind: 'years', from: GITHUB_EPOCH_YEAR, to: EARLY_YEARS_END }];
    for (let year = EARLY_YEARS_END + 1; year <= currentYear; year += 1) {
      out.push({ kind: 'year', year });
    }
    return out;
  }

  switch (created.kind) {
    case 'years': {
      const out: Created[] = [];
      for (let year = created.from; year <= created.to; year += 1) out.push({ kind: 'year', year });
      return out;
    }
    case 'year':
      return [1, 2, 3, 4].map((quarter) => ({ kind: 'quarter', year: created.year, quarter }));
    case 'quarter': {
      const first = (created.quarter - 1) * 3 + 1;
      return [first, first + 1, first + 2].map((month) => ({
        kind: 'month',
        year: created.year,
        month,
      }));
    }
    case 'month': {
      const out: Created[] = [];
      for (let day = 1; day <= daysInMonth(created.year, created.month); day += 1) {
        out.push({ kind: 'day', date: iso(created.year, created.month, day) });
      }
      return out;
    }
    case 'day':
      return [];
  }
}

/** The GitHub search query this window represents. Doubles as its identity in resume state. */
export function queryOf(window: Window): string {
  const parts = [window.base, `stars:${window.stars}`];
  const range = createdRange(window.created);
  if (range !== null) parts.push(`created:${range}`);
  return parts.join(' ');
}

function createdRange(created: Created | null): string | null {
  if (created === null) return null;
  switch (created.kind) {
    case 'years':
      return `${created.from}-01-01..${created.to}-12-31`;
    case 'year':
      return `${created.year}-01-01..${created.year}-12-31`;
    case 'quarter': {
      const first = (created.quarter - 1) * 3 + 1;
      const last = first + 2;
      return `${iso(created.year, first, 1)}..${iso(created.year, last, daysInMonth(created.year, last))}`;
    }
    case 'month':
      return `${iso(created.year, created.month, 1)}..${iso(
        created.year,
        created.month,
        daysInMonth(created.year, created.month),
      )}`;
    case 'day':
      return created.date;
  }
}

/** `month` is 1-indexed; day 0 of the next month is the last day of this one. */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const pad = (value: number): string => String(value).padStart(2, '0');
const iso = (year: number, month: number, day: number): string =>
  `${year}-${pad(month)}-${pad(day)}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/windows.test.ts`
Expected: PASS, 9 tests.

Note: the band `1000..5000` overlaps `>5000` at neither end — `>5000` starts at 5001, so the contiguity assertion holds. If the test fails on that assertion, the bands were edited; fix the bands, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/discovery/windows.ts apps/workers/src/discovery/windows.test.ts
git commit -m "feat(discovery): calendar-aligned search window algebra"
```

---

## Task 4: Discovery store

Owns every read and write under `discovery/`, plus the in-memory maps that make change detection a lookup rather than 100k file reads.

**Files:**
- Create: `apps/workers/src/discovery/store.ts`
- Create: `apps/workers/src/discovery/store.test.ts`
- Modify: `apps/workers/package.json`

- [ ] **Step 1: Add the yaml dependency**

Edit `apps/workers/package.json`, adding `yaml` to `dependencies`:

```json
  "dependencies": {
    "@keco/analyze": "workspace:*",
    "@keco/cache": "workspace:*",
    "@keco/core": "workspace:*",
    "@keco/github": "workspace:*",
    "@keco/search": "workspace:*",
    "@keco/signals": "workspace:*",
    "dotenv": "^17.4.2",
    "pino": "^10.3.1",
    "yaml": "^2.8.1",
    "zod": "^4.4.3"
  },
```

Then run: `pnpm install`
Expected: completes, `apps/workers/node_modules/yaml` exists.

- [ ] **Step 2: Write the failing test**

Create `apps/workers/src/discovery/store.test.ts`. It uses a real temp directory and `FsStorage`, matching the convention in `packages/cache/src/journal.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, FsStorage, discoveryKeys } from '@keco/cache';
import type { SearchItem } from '@keco/github';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscoveryStore, toDetail } from './store';

const item = (overrides: Partial<SearchItem> = {}): SearchItem =>
  ({
    id: 20038725,
    full_name: 'ahmetb/kubectx',
    name: 'kubectx',
    owner: { login: 'ahmetb' },
    description: 'Faster way to switch between clusters',
    homepage: 'https://kubectx.dev',
    stargazers_count: 18234,
    forks_count: 1180,
    open_issues_count: 41,
    language: 'Go',
    license: { spdx_id: 'Apache-2.0' },
    topics: ['kubectl', 'kubernetes'],
    archived: false,
    fork: false,
    default_branch: 'master',
    created_at: '2014-05-22T12:00:00Z',
    updated_at: '2026-07-20T08:11:00Z',
    pushed_at: '2026-07-14T19:02:00Z',
    ...overrides,
  }) as SearchItem;

describe('toDetail', () => {
  it('flattens the search item into the documented shape', () => {
    const doc = toDetail(item(), 'kubernetes stars:>5000', '2026-08-02T09:30:00Z');

    expect(doc.owner).toBe('ahmetb');
    expect(doc.stars).toBe(18234);
    expect(doc.license).toBe('Apache-2.0');
    expect(doc.discovered_via).toBe('kubernetes stars:>5000');
    expect(doc.discovered_at).toBe('2026-08-02T09:30:00Z');
    expect(doc.payload_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('excludes discovered_at from the hash, or every file would look changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item(), 'q', '2026-09-14T22:00:00Z');
    expect(a.payload_hash).toBe(b.payload_hash);
  });

  it('changes the hash when the repo really changed', () => {
    const a = toDetail(item(), 'q', '2026-08-02T09:30:00Z');
    const b = toDetail(item({ stargazers_count: 18999 }), 'q', '2026-08-02T09:30:00Z');
    expect(a.payload_hash).not.toBe(b.payload_hash);
  });

  it('sorts topics so their order cannot churn the hash', () => {
    const a = toDetail(item({ topics: ['a', 'b'] }), 'q', 'now');
    const b = toDetail(item({ topics: ['b', 'a'] }), 'q', 'now');
    expect(a.payload_hash).toBe(b.payload_hash);
  });
});

describe('DiscoveryStore', () => {
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'keco-discovery-'));
    cache = new Cache(new FsStorage(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a detail document at its bucket path and reports it as new', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');

    expect(await store.record(item(), 'kubernetes stars:>5000')).toBe('new');

    const raw = await cache.getText(discoveryKeys.detail('ahmetb/kubectx'));
    expect(raw).not.toBeNull();
    expect(parse(raw!).full_name).toBe('ahmetb/kubectx');
  });

  it('skips the write when the payload is unchanged', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item(), 'q')).toBe('unchanged');
  });

  it('rewrites when the payload changed', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item({ stargazers_count: 19000 }), 'q')).toBe('changed');

    const raw = await cache.getText(discoveryKeys.detail('ahmetb/kubectx'));
    expect(parse(raw!).stars).toBe(19000);
  });

  it('writes the full list as id, path and name only, sorted by path', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item({ id: 2, full_name: 'zz/last', name: 'last' }), 'q');
    await store.record(item({ id: 1, full_name: 'aa/first', name: 'first' }), 'q');
    await store.flush();

    const list = parse((await cache.getText(discoveryKeys.fullList))!);
    expect(list).toEqual([
      { id: 1, path: 'aa/first', name: 'first' },
      { id: 2, path: 'zz/last', name: 'last' },
    ]);
  });

  it('deduplicates by repo id across windows, keeping the first sighting', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');

    expect(await store.record(item(), 'window-a')).toBe('new');
    // The same repo turning up in an overlapping window must not rewrite the document just
    // because discovered_via would differ — that would be a wasted write per duplicate.
    expect(await store.record(item(), 'window-b')).toBe('unchanged');
    await store.flush();

    expect(store.size).toBe(1);
    expect(parse((await cache.getText(discoveryKeys.fullList))!)).toHaveLength(1);

    const raw = await cache.getText(discoveryKeys.detail('ahmetb/kubectx'));
    expect(parse(raw!).discovered_via).toBe('window-a');
  });

  it('resumes the pending queue and completed windows', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    store.state.pending_windows = [{ base: 'kubernetes', stars: '0', created: null }];
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.flush();

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(resumed.state.pending_windows).toHaveLength(1);
    expect(resumed.state.completed_windows).toEqual(['kubernetes stars:>5000']);
  });

  it('ignores state written for a different query', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.record(item(), 'q');
    await store.flush();

    const other = await DiscoveryStore.open(cache, 'istio');
    expect(other.state.completed_windows).toEqual([]);
    expect(other.size).toBe(0);
  });

  it('starts over when opened fresh', async () => {
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    store.state.completed_windows = ['kubernetes stars:>5000'];
    await store.flush();

    const fresh = await DiscoveryStore.open(cache, 'kubernetes', { fresh: true });
    expect(fresh.size).toBe(0);
    expect(fresh.state.completed_windows).toEqual([]);
  });

  it('rewrites a detail document whose entry is missing from the list', async () => {
    // Guards a torn flush: hashes landed, the list did not.
    const store = await DiscoveryStore.open(cache, 'kubernetes');
    await store.record(item(), 'q');
    await store.flush();
    await cache.putText(discoveryKeys.fullList, '[]');

    const resumed = await DiscoveryStore.open(cache, 'kubernetes');
    expect(await resumed.record(item(), 'q')).toBe('new');
    expect(resumed.size).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/workers/src/discovery/store.test.ts`
Expected: FAIL — cannot resolve `./store`.

- [ ] **Step 4: Implement**

Create `apps/workers/src/discovery/store.ts`:

```ts
import { createHash } from 'node:crypto';
import { type Cache, discoveryKeys } from '@keco/cache';
import type { SearchItem } from '@keco/github';
import { parse, stringify } from 'yaml';
import type { Window } from './windows';

/**
 * Everything discovery reads and writes (design 2026-08-02). All of it through the Storage
 * port — no fs, no path building (AGENTS.md §14).
 *
 * The full list and the hash index are held in memory for the length of a run, which is what
 * makes change detection a map lookup instead of re-reading 100k YAML files per sweep. At
 * ~100k repos that is roughly 11 MB of process memory, and it buys hours.
 */

/** Exactly the three fields the full list carries. */
export type ListEntry = { id: number; path: string; name: string };

export type DetailDoc = {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  forks: number;
  open_issues: number;
  language: string | null;
  license: string | null;
  topics: string[];
  archived: boolean;
  fork: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  discovered_via: string;
  discovered_at: string;
  payload_hash: string;
};

export type FailedWindow = { window: string; error: string };

export type DiscoveryState = {
  query: string;
  started_at: string;
  /**
   * The live queue, serialised. Without it a resume loses every window produced by
   * subdivision: the parent is marked complete and its children existed only in memory.
   */
  pending_windows: Window[];
  completed_windows: string[];
  failed_windows: FailedWindow[];
  repos_seen: number;
  requests: number;
};

export type RecordOutcome = 'new' | 'changed' | 'unchanged';

/**
 * Covers every field except `discovered_at` and `payload_hash` itself. Including
 * `discovered_at` would make every document look changed on every run.
 *
 * `stars` IS included, unlike `contentHash` in @keco/cache which deliberately excludes it.
 * The two serve different purposes: contentHash gates expensive re-analysis, so star churn
 * must not trigger it; this hash gates a file write whose whole content is that star count,
 * so excluding it would leave the document asserting a number the search no longer reports.
 * The practical consequence is that a weekly sweep rewrites most documents — correct, and the
 * reason the skip mostly pays off on same-day re-runs and resumes.
 */
export function toDetail(item: SearchItem, via: string, discoveredAt: string): DetailDoc {
  const core = {
    id: item.id,
    full_name: item.full_name,
    name: item.name,
    owner: item.owner?.login ?? item.full_name.split('/')[0] ?? '',
    description: item.description ?? null,
    homepage: item.homepage ?? null,
    stars: item.stargazers_count,
    forks: item.forks_count,
    open_issues: item.open_issues_count,
    language: item.language ?? null,
    license: item.license?.spdx_id ?? null,
    topics: [...item.topics].sort(),
    archived: item.archived,
    fork: item.fork,
    default_branch: item.default_branch,
    created_at: item.created_at,
    updated_at: item.updated_at,
    pushed_at: item.pushed_at ?? null,
    discovered_via: via,
  };
  const payload_hash = createHash('sha256')
    .update(JSON.stringify(core))
    .digest('hex')
    .slice(0, 32);
  return { ...core, discovered_at: discoveredAt, payload_hash };
}

export class DiscoveryStore {
  /**
   * Repos already recorded during this process. Star bands and date windows do not overlap
   * in principle, but a window that exceeded 1000 contributes its first 100 results and then
   * subdivides, so its children re-yield those same repos. Without this set the second
   * sighting would differ only in `discovered_via`, hash differently, and rewrite the
   * document — one wasted write per duplicate, across the whole corpus.
   */
  private readonly seenThisRun = new Set<number>();

  private constructor(
    private readonly cache: Cache,
    private readonly entries: Map<number, ListEntry>,
    private readonly hashes: Map<string, string>,
    readonly state: DiscoveryState,
  ) {}

  /**
   * Loads prior artifacts unless `fresh`. State written for a different query is discarded:
   * its completed-window list means nothing for a different keyword.
   */
  static async open(
    cache: Cache,
    query: string,
    options: { fresh?: boolean; now?: Date } = {},
  ): Promise<DiscoveryStore> {
    const now = options.now ?? new Date();
    const stored = options.fresh
      ? null
      : await cache.getJSON<DiscoveryState>(discoveryKeys.state);
    const usable = stored !== null && stored.query === query ? stored : null;

    const entries = new Map<number, ListEntry>();
    const hashes = new Map<string, string>();

    if (usable !== null) {
      const listYaml = await cache.getText(discoveryKeys.fullList);
      const list = listYaml === null ? [] : ((parse(listYaml) as ListEntry[] | null) ?? []);
      for (const entry of list) entries.set(entry.id, entry);

      const stored_hashes =
        (await cache.getJSON<Record<string, string>>(discoveryKeys.hashes)) ?? {};
      for (const [repo, hash] of Object.entries(stored_hashes)) hashes.set(repo, hash);
    }

    const state: DiscoveryState = usable ?? {
      query,
      started_at: now.toISOString(),
      pending_windows: [],
      completed_windows: [],
      failed_windows: [],
      repos_seen: 0,
      requests: 0,
    };

    return new DiscoveryStore(cache, entries, hashes, state);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Records one search hit, writing its detail document only when the payload changed.
   * The first window to find a repo owns its `discovered_via`; later sightings are dropped.
   * The `entries` check also covers a torn flush, where hashes landed but the list did not.
   */
  async record(item: SearchItem, via: string, now = new Date()): Promise<RecordOutcome> {
    if (this.seenThisRun.has(item.id)) return 'unchanged';
    const doc = toDetail(item, via, now.toISOString());
    const known = this.entries.has(doc.id);
    if (known && this.hashes.get(doc.full_name) === doc.payload_hash) {
      this.seenThisRun.add(doc.id);
      return 'unchanged';
    }

    await this.cache.putText(
      discoveryKeys.detail(doc.full_name),
      stringify(doc),
      'application/yaml',
    );
    this.hashes.set(doc.full_name, doc.payload_hash);
    this.entries.set(doc.id, { id: doc.id, path: doc.full_name, name: doc.name });
    this.seenThisRun.add(doc.id);
    return known ? 'changed' : 'new';
  }

  /**
   * Writes all three shared artifacts. Called at window boundaries so a kill leaves the list,
   * the hashes and the resume point agreeing with each other.
   */
  async flush(): Promise<void> {
    this.state.repos_seen = this.entries.size;
    const list = [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path));
    await this.cache.putText(discoveryKeys.fullList, stringify(list), 'application/yaml');
    await this.cache.putJSON(discoveryKeys.hashes, Object.fromEntries(this.hashes));
    await this.cache.putJSON(discoveryKeys.state, this.state);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/workers/src/discovery/store.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/discovery/store.ts apps/workers/src/discovery/store.test.ts \
        apps/workers/package.json pnpm-lock.yaml
git commit -m "feat(discovery): YAML artifacts, change-gated writes and resume state"
```

---

## Task 5: Progress reporting

Renders to **stderr**, never stdout, because pino owns stdout and `mise run discovery > out.log` has to stay parseable. Non-TTY falls back to periodic log lines instead of filling CI logs with redraw escape sequences.

**Files:**
- Create: `apps/workers/src/lib/progress.ts`
- Create: `apps/workers/src/lib/progress.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/workers/src/lib/progress.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createProgress, formatDuration } from './progress';

const sink = (isTTY: boolean) => {
  const written: string[] = [];
  return { written, stream: { isTTY, write: (chunk: string) => void written.push(chunk) } };
};

describe('formatDuration', () => {
  it('renders coarse, human units', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m');
    expect(formatDuration(3_600_000)).toBe('1h0m');
    expect(formatDuration(5_400_000)).toBe('1h30m');
  });
});

describe('createProgress on a TTY', () => {
  it('redraws a single line carrying every counter', () => {
    const { written, stream } = sink(true);
    let clock = 0;
    const progress = createProgress({ stream, now: () => clock });

    clock = 60_000;
    progress.update({ repos: 42904, windowsDone: 187, windowsKnown: 301, requests: 2140 });

    const line = written.join('');
    expect(line).toContain('\r');
    expect(line).toContain('42,904 repos');
    expect(line).toContain('window 187/301');
    expect(line).toContain('2,140 req');
    expect(line).toContain('eta');
  });

  it('throttles redraws so a fast loop does not thrash the terminal', () => {
    const { written, stream } = sink(true);
    let clock = 0;
    const progress = createProgress({ stream, now: () => clock, redrawMs: 100 });

    progress.update({ repos: 1, windowsDone: 1, windowsKnown: 10, requests: 1 });
    const afterFirst = written.length;
    clock = 50;
    progress.update({ repos: 2, windowsDone: 2, windowsKnown: 10, requests: 2 });
    expect(written.length).toBe(afterFirst);

    clock = 150;
    progress.update({ repos: 3, windowsDone: 3, windowsKnown: 10, requests: 3 });
    expect(written.length).toBeGreaterThan(afterFirst);
  });

  it('clears the line when done so the shell prompt is not left mid-bar', () => {
    const { written, stream } = sink(true);
    const progress = createProgress({ stream, now: () => 0 });
    progress.update({ repos: 1, windowsDone: 1, windowsKnown: 1, requests: 1 });
    progress.done();
    expect(written.at(-1)).toContain('\n');
  });
});

describe('createProgress without a TTY', () => {
  it('logs instead of drawing, and emits no escape codes', () => {
    const { written, stream } = sink(false);
    const log = { info: vi.fn() };
    let clock = 0;
    const progress = createProgress({ stream, log, now: () => clock, intervalMs: 15_000 });

    progress.update({ repos: 10, windowsDone: 1, windowsKnown: 10, requests: 5 });
    expect(log.info).toHaveBeenCalledTimes(1);

    clock = 5_000; // inside the interval
    progress.update({ repos: 20, windowsDone: 2, windowsKnown: 10, requests: 9 });
    expect(log.info).toHaveBeenCalledTimes(1);

    clock = 20_000; // past it
    progress.update({ repos: 30, windowsDone: 3, windowsKnown: 10, requests: 14 });
    expect(log.info).toHaveBeenCalledTimes(2);

    expect(written).toEqual([]);
    expect(log.info.mock.calls[0]![0]).toMatchObject({ repos: 10, windows_done: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/workers/src/lib/progress.test.ts`
Expected: FAIL — cannot resolve `./progress`.

- [ ] **Step 3: Implement**

Create `apps/workers/src/lib/progress.ts`:

```ts
/**
 * Progress reporting for long sweeps (design 2026-08-02).
 *
 * Writes to stderr, never stdout: pino owns stdout, and `mise run discovery > out.log` has to
 * stay parseable JSON. Without a TTY it degrades to periodic log lines rather than filling a
 * CI log with carriage returns.
 */

export type ProgressSnapshot = {
  repos: number;
  windowsDone: number;
  windowsKnown: number;
  requests: number;
};

export interface Progress {
  update(snapshot: ProgressSnapshot): void;
  done(): void;
}

type Sink = { isTTY?: boolean; write(chunk: string): void };
type Log = { info(fields: object, message: string): void };

export type ProgressOptions = {
  stream?: Sink;
  log?: Log;
  now?: () => number;
  /** Minimum gap between TTY redraws. */
  redrawMs?: number;
  /** Minimum gap between non-TTY log lines. */
  intervalMs?: number;
};

const BAR_WIDTH = 24;

export function createProgress(options: ProgressOptions = {}): Progress {
  const stream: Sink = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  const redrawMs = options.redrawMs ?? 100;
  const intervalMs = options.intervalMs ?? 15_000;
  const startedAt = now();
  const tty = stream.isTTY === true;

  let lastEmit = -Infinity;
  let drawn = false;

  const eta = (snapshot: ProgressSnapshot): string => {
    if (snapshot.windowsDone === 0) return '—';
    const elapsed = now() - startedAt;
    const remaining = Math.max(0, snapshot.windowsKnown - snapshot.windowsDone);
    return formatDuration((elapsed / snapshot.windowsDone) * remaining);
  };

  return {
    update(snapshot) {
      const at = now();
      if (at - lastEmit < (tty ? redrawMs : intervalMs)) return;
      lastEmit = at;

      if (!tty) {
        options.log?.info(
          {
            repos: snapshot.repos,
            windows_done: snapshot.windowsDone,
            windows_known: snapshot.windowsKnown,
            requests: snapshot.requests,
            eta: eta(snapshot),
          },
          'discovering',
        );
        return;
      }

      const ratio =
        snapshot.windowsKnown === 0
          ? 0
          : Math.min(1, snapshot.windowsDone / snapshot.windowsKnown);
      const filled = Math.round(ratio * BAR_WIDTH);
      const bar = '#'.repeat(filled) + '·'.repeat(BAR_WIDTH - filled);
      stream.write(
        `\rdiscovering  [${bar}]  ${count(snapshot.repos)} repos · window ` +
          `${snapshot.windowsDone}/${snapshot.windowsKnown} · ${count(snapshot.requests)} req · ` +
          `eta ${eta(snapshot)}   `,
      );
      drawn = true;
    },

    done() {
      if (tty && drawn) stream.write('\n');
    },
  };
}

const count = (value: number): string => value.toLocaleString('en-US');

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/workers/src/lib/progress.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/lib/progress.ts apps/workers/src/lib/progress.test.ts
git commit -m "feat(workers): stderr progress bar with a non-TTY logging fallback"
```

---

## Task 6: The worker

Thin orchestration over the four modules built above.

**Files:**
- Create: `apps/workers/src/discovery/index.ts`
- Modify: `apps/workers/package.json`
- Modify: `mise.toml`
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Write the worker**

Create `apps/workers/src/discovery/index.ts`:

```ts
import { parseArgs } from 'node:util';
import { SearchClient, type SearchItem } from '@keco/github';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createProgress } from '../lib/progress';
import { createRuntime } from '../lib/runtime';
import { DiscoveryStore } from './store';
import { initialWindows, queryOf, split, type Window } from './windows';

/**
 * discovery — GitHub Search → `discovery/repos-full-list.yaml` + one detail document per repo
 * (design 2026-08-02). Runs before the crawler, which reads the full list.
 *
 * GitHub Search caps every query at 1000 results, so the keyword is split into star bands and
 * any window still over 1000 subdivides by creation date until it fits. The probe request is
 * page 1 itself: it carries both the total_count that drives the decision and 100 real results.
 *
 * Deliberately appends no journal events. Discovery publishes a file rather than a stream; see
 * the design document for what that costs and why it was chosen.
 */
const log = workerLogger('discovery');

/** GitHub Search never returns more than this, however many pages you ask for. */
const MAX_RESULTS_PER_QUERY = 1000;
const PER_PAGE = 100;

const { values } = parseArgs({
  options: {
    query: { type: 'string', default: 'kubernetes' },
    limit: { type: 'string' },
    fresh: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

async function main(): Promise<void> {
  const query = values.query!;
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive number, got "${values.limit}"`);
  }

  // Unauthenticated search is 10 req/min, which turns a two-hour sweep into a six-hour one.
  // Failing now beats discovering that at hour four.
  if (config.GITHUB_TOKEN === '') {
    log.error('GITHUB_TOKEN is required for discovery — unauthenticated search is 10 req/min');
    process.exitCode = 1;
    return;
  }

  const { cache } = createRuntime();
  const store = await DiscoveryStore.open(cache, query, { fresh: values.fresh });
  const search = SearchClient.fromToken(config.GITHUB_TOKEN);
  const progress = createProgress({ log });

  // A non-empty queue means the last sweep was interrupted, so continue it. An empty one
  // means the last sweep finished (or there was none): start a new sweep over every window.
  // Only the window bookkeeping resets — the repo list and the hashes carry over, which is
  // what makes a second sweep re-check the corpus while still skipping unchanged documents.
  const resuming = store.state.pending_windows.length > 0;
  if (!resuming) {
    store.state.completed_windows = [];
    store.state.failed_windows = [];
    store.state.started_at = new Date().toISOString();
  }

  const queue: Window[] = resuming ? store.state.pending_windows : initialWindows(query);
  const completed = new Set(store.state.completed_windows);

  log.info(
    { query, limit, fresh: values.fresh, resuming, known_repos: store.size, windows: queue.length },
    'discovery start',
  );

  let stopped = false;

  while (queue.length > 0 && !stopped) {
    const window = queue.shift()!;
    const q = queryOf(window);

    if (completed.has(q)) continue;

    try {
      const first = await search.page(q, 1, PER_PAGE);
      store.state.requests += 1;
      await recordAll(store, first.items, q);

      if (first.total_count > MAX_RESULTS_PER_QUERY) {
        const parts = split(window);
        if (parts.length === 0) {
          // A single day still over 1000. Vanishingly rare, and visible rather than silent.
          log.warn(
            { window: q, total_count: first.total_count },
            'window exceeds 1000 at day granularity — truncated',
          );
        } else {
          queue.push(...parts);
          log.debug({ window: q, total_count: first.total_count, parts: parts.length }, 'split');
        }
      } else {
        const pages = Math.ceil(Math.min(first.total_count, MAX_RESULTS_PER_QUERY) / PER_PAGE);
        for (let page = 2; page <= pages; page += 1) {
          const next = await search.page(q, page, PER_PAGE);
          store.state.requests += 1;
          await recordAll(store, next.items, q);
        }
      }

      completed.add(q);
      store.state.completed_windows.push(q);
    } catch (error) {
      // One bad window never aborts a sweep (§13).
      const message = error instanceof Error ? error.message : String(error);
      store.state.failed_windows.push({ window: q, error: message });
      log.error({ window: q, error: message }, 'window failed');
    }

    // Flush at the window boundary so list, hashes and resume point always agree.
    store.state.pending_windows = queue;
    await store.flush();

    progress.update({
      repos: store.size,
      windowsDone: completed.size,
      windowsKnown: completed.size + queue.length,
      requests: store.state.requests,
    });

    // Checked between windows: a started window is always finished, which keeps
    // completed_windows truthful, so the final count can overshoot the limit slightly.
    if (limit !== null && store.size >= limit) stopped = true;
  }

  progress.done();

  log.info(
    {
      repos: store.size,
      windows_completed: completed.size,
      windows_failed: store.state.failed_windows.length,
      windows_pending: queue.length,
      requests: store.state.requests,
      stopped_at_limit: stopped,
    },
    'discovery complete',
  );
}

async function recordAll(
  store: DiscoveryStore,
  items: readonly SearchItem[],
  via: string,
): Promise<void> {
  for (const item of items) {
    try {
      await store.record(item, via);
    } catch (error) {
      // A single malformed repo must never abort the run (§13).
      log.warn(
        { repo: item.full_name, error: error instanceof Error ? error.message : String(error) },
        'could not record repo',
      );
    }
  }
}

await main();
```

- [ ] **Step 2: Add the package script**

Edit `apps/workers/package.json`, adding to `scripts` after `"crawler"`:

```json
    "discovery": "tsx src/discovery/index.ts",
```

- [ ] **Step 3: Add the mise task**

Edit `mise.toml`, inserting immediately before the `[tasks.crawler]` block:

```toml
[tasks.discovery]
description = "Enumerate GitHub repos matching a keyword into discovery/*.yaml. Args: --query kubernetes --limit 500 --fresh"
run = "pnpm -F @keco/workers discovery"
```

- [ ] **Step 4: Extend the lint boundary**

Edit `eslint.config.mjs`. In the "Only the projector writes to Meilisearch" block, add the discovery worker to `files`:

```js
  // Only the projector writes to Meilisearch.
  {
    files: [
      'apps/workers/src/discovery/**/*.ts',
      'apps/workers/src/crawler/**/*.ts',
      'apps/workers/src/analyzer/**/*.ts',
    ],
    rules: boundary(
      'Only the projector may import @keco/search. The write side never reads a read model (§2.1).',
      [['@keco/search']],
    ),
  },
```

- [ ] **Step 5: Verify it typechecks and lints**

Run: `pnpm -F @keco/workers check && pnpm eslint apps/workers/src/discovery`
Expected: both exit 0 with no output.

- [ ] **Step 6: Verify the CLI refuses to start without a token**

Run: `GITHUB_TOKEN= pnpm -F @keco/workers discovery -- --limit 5`
Expected: one error line containing `GITHUB_TOKEN is required for discovery`, exit code 1.

- [ ] **Step 7: Commit**

```bash
git add apps/workers/src/discovery/index.ts apps/workers/package.json mise.toml eslint.config.mjs
git commit -m "feat(discovery): the worker, its mise task and its lint boundary"
```

---

## Task 7: Full gate and a real run

- [ ] **Step 1: Run the whole gate**

Run: `mise run ci`
Expected: `check`, `lint`, `test` and `taxonomy:check` all pass. Fix anything red before continuing — §15 is not negotiable.

- [ ] **Step 2: Cold small run against real GitHub**

Requires a `GITHUB_TOKEN` in `.env`.

Run: `mise run discovery -- --limit 300 --fresh`

Expected:
- a progress bar on stderr that advances
- a final `discovery complete` line reporting roughly 300 or more repos
- the run finishes in a couple of minutes (the top star bands are small)

- [ ] **Step 3: Verify the artifacts**

```bash
head -20 .cache/discovery/repos-full-list.yaml
find .cache/discovery -name 'repo-details-*.yaml' | head -5
find .cache/discovery -name 'repo-details-*.yaml' | wc -l
```

Expected:
- the full list is a YAML array whose every entry has exactly `id`, `path` and `name`
- detail files sit two directories deep, e.g. `.cache/discovery/a/h/repo-details-ahmetb__kubectx.yaml`
- the file count matches the reported repo count

- [ ] **Step 4: Verify a re-run skips unchanged repos**

Run: `mise run discovery -- --limit 300`

Expected: completes far faster than the cold run, and `repos` in the summary does not grow much. Detail files whose star counts moved since the first run are rewritten; the rest are untouched. Confirm with:

```bash
find .cache/discovery -name 'repo-details-*.yaml' -mmin -2 | wc -l
```

Expected: substantially fewer than the total file count.

- [ ] **Step 5: Verify resume**

Start a fresh larger run, kill it partway, restart it:

```bash
mise run discovery -- --fresh --limit 5000 &
sleep 90 && kill %1
cat .cache/discovery/_state.json | head -5
mise run discovery -- --limit 5000
```

Expected: `_state.json` holds a non-empty `pending_windows`; the restarted run logs `resuming: true` with a non-zero `known_repos`, and the full list gains no duplicate `path` values:

```bash
grep -c '^- id:' .cache/discovery/repos-full-list.yaml
grep '  path:' .cache/discovery/repos-full-list.yaml | sort | uniq -d | wc -l
```

Expected: the duplicate count is `0`.

- [ ] **Step 6: Commit nothing, or fix and commit**

The cache is gitignored, so a successful run produces no diff. If any step above required a code fix, commit it:

```bash
git add -A
git commit -m "fix(discovery): <what the real run exposed>"
```

---

## Task 8: Reconcile the spec

The two corrections at the top of this plan are real design changes and the spec must not disagree with the code.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-discovery-worker-design.md`

- [ ] **Step 1: Add `pending_windows` to the documented state**

In the "Resume and failure" section, replace the `_state.json` example with:

```json
{
  "query": "kubernetes",
  "started_at": "2026-08-02T09:30:00Z",
  "pending_windows": [{ "base": "kubernetes", "stars": "0", "created": { "kind": "year", "year": 2021 } }],
  "completed_windows": ["kubernetes stars:>5000"],
  "failed_windows": [{ "window": "...", "error": "..." }],
  "repos_seen": 42904,
  "requests": 2140
}
```

And add this bullet to the list beneath it:

```markdown
- `pending_windows` is the live queue, serialised. Without it a resume loses every window
  produced by subdivision: the parent is recorded complete and its children existed only in
  memory.
- An empty `pending_windows` means the last sweep finished, so the next run starts a **new**
  sweep: `completed_windows` and `failed_windows` reset while the repo list and the hashes
  carry over. Without that reset a second run would skip every window and do nothing.
```

- [ ] **Step 2: Correct the rewrite-rate expectation**

In the "Detail document" section, after the paragraph explaining that `payload_hash` excludes
`discovered_at`, add:

```markdown
`stars` is deliberately inside the hash, unlike `contentHash` in `@keco/cache`, which excludes
it so star churn cannot trigger expensive re-analysis. Here the star count *is* the content, so
excluding it would leave a document asserting a number the search no longer reports. The
consequence is that a weekly sweep rewrites most documents rather than a few hundred — correct
behaviour, and the reason the skip mostly pays off on same-day re-runs and on resumes.
```

- [ ] **Step 3: Record the extra split level**

In the "Reaching the whole corpus" section, change the split-order list item 2 from
`created:` year to:

```markdown
2. `created:` — a single pre-2014 bucket (`2008-01-01..2013-12-31`), then one window per calendar year
```

- [ ] **Step 4: Mark the spec implemented**

Change the header line `Status: designed, not implemented` to:

```markdown
Status: implemented on `feat/discovery-worker`
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-02-discovery-worker-design.md
git commit -m "docs(discovery): reconcile the spec with the implementation"
```

---

## Definition of done

Every one of these must hold before the branch is offered for review:

1. `mise run ci` green.
2. `mise run discovery -- --limit 500 --fresh` from a cold cache produces a well-formed
   `repos-full-list.yaml` and the matching bucket tree.
3. Re-running the same command writes far fewer detail files than the total, and adds no
   duplicate entries to the full list.
4. Killing a run mid-sweep and restarting resumes from `pending_windows` rather than starting
   over, with no duplicate `path` values in the full list.
5. No `fs` access and no path construction outside `packages/cache`.
6. Nothing on the read side is touched; discovery writes only under `discovery/`.
7. The spec document and the code agree (Task 8).
