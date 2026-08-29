# `kecoctl` — one CLI for `apps/workers` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the seven entrypoints of `apps/workers` with one commander program, `kecoctl`, grouped by noun, so that argument parsing lives in a layer with no import-time side effects and therefore has tests.

**Architecture:** Three layers. `src/cli/program.ts` builds the command tree and takes its handlers as a *parameter* (so tests build it with stubs — no cache, no Meilisearch, no network). `src/cli/handlers.ts` supplies the real handlers as lazy `await import()` calls, keeping `sharp`/`meilisearch`/`@keco/analyze` out of a `--help`. `src/cli.ts` is a six-line entrypoint. Every worker module loses its `parseArgs` block and its top-level `await main()`, and exports `run*(options)` instead.

**Tech Stack:** TypeScript (ESM, `strict`, `moduleResolution: bundler`), commander 15, vitest, pino, mise, eslint flat config.

**Spec:** `docs/superpowers/specs/2026-08-26-workers-cli-design.md`

---

## Context you need before starting

Read `AGENTS.md` §2 (CQRS), §4 (workers), §7 (import boundaries), §13 (conventions) and §15 (definition of done). Then read the spec above in full. The three things most likely to trip you up:

1. **`node --import tsx`, not `tsx`.** The single npm script must be `node --import tsx src/cli.ts`. Using the `tsx` CLI silently destroys `discovery sweep`'s crash-safety — see Task 12 and `src/lib/shutdown.ts:28-33`. There is a test for it because the failure produces no error and no log line.
2. **Imports are extensionless.** `moduleResolution` is `bundler` (`tsconfig.base.json`), so it is `await import('../crawler')`, never `'../crawler/index.js'`.
3. **This refactor touches no worker logic.** `crawler`, `analyzer` and `projector` are stubs today and stay stubs. Their TODO comment blocks are preserved *verbatim*. If you find yourself implementing a worker, stop — that is a different plan.

Run `mise run ci` before declaring any task done. Individual test runs use `pnpm vitest run <path>` from the repo root.

---

## File structure

**Create:**

| File | Responsibility |
| --- | --- |
| `apps/workers/src/lib/cli.ts` | Shared commander pieces: argument validators, the Meilisearch target options, the `run()` error boundary. No command knows about another. |
| `apps/workers/src/lib/cli.test.ts` | Tests for the validators and the boundary's three-way exit branch. |
| `apps/workers/src/cli/program.ts` | The command tree. Names, flags, help text. Takes `Handlers` as a parameter; imports no worker at runtime. |
| `apps/workers/src/cli/program.test.ts` | Builds the tree with stub handlers and asserts what each argv produces. |
| `apps/workers/src/cli/handlers.ts` | One lazy `await import()` per command. The only file that names every worker. |
| `apps/workers/src/cli/entrypoint.test.ts` | Asserts the npm script still uses `node --import tsx`. |
| `apps/workers/src/cli.ts` | Entrypoint. `run('kecoctl', () => buildProgram(handlers).parseAsync())`. |

**Modify:**

| File | Change |
| --- | --- |
| `apps/workers/src/discovery/index.ts` | Drop `parseArgs` + the positional guard + the trailing `try/catch`; export `runDiscovery(options)` and `DiscoveryOptions`. |
| `apps/workers/src/crawler/index.ts` | Drop `parseArgs` + `await main()`; export `runCrawler(options)` and `CrawlOptions`. TODO block untouched. |
| `apps/workers/src/analyzer/index.ts` | Same shape; export `runAnalyzer(options)` and `AnalyzeOptions`. |
| `apps/workers/src/projector/index.ts` | Same shape; export `runProjector(options)` and `ProjectOptions`. |
| `apps/workers/src/replay/index.ts` | Becomes a module exporting `runCheckpointReset(options)`; loses its own validation and `process.exit`. |
| `apps/workers/package.json` | Seven scripts → `check` + `kecoctl`. |
| `eslint.config.mjs` | New boundary block for `apps/workers/src/cli/**`. |
| `mise.toml` | Task renames; prose descriptions move into commander. |
| `AGENTS.md` | §4 (icon reference), §7 (layout tree), §8 (command table). |

**Rename:**

| From | To |
| --- | --- |
| `apps/workers/src/engine/` | `apps/workers/src/read-model/` (`create-index.ts`, `seed.ts`, `corpus.ts` + their tests, content unchanged) |
| `apps/workers/src/engine/cli.ts` | deleted — wiring moves to `src/cli/program.ts`, helpers to `src/lib/cli.ts` |
| `apps/workers/src/crawler/icon-cli.ts` | `apps/workers/src/crawler/icon-run.ts`, exporting `runIcon(options)` |

---

## Task order and why

Tasks 1–2 build the shared foundation with no callers. Task 3 builds the command tree against stub handlers, so the entire CLI surface is tested before a single worker is touched. Tasks 4–9 convert one worker at a time — each is independently committable and leaves the repo green. Task 10 wires the real handlers. Tasks 11–14 are the surfaces: entrypoint, package.json, lint, mise, docs.

---

### Task 1: Shared CLI validators

**Files:**
- Create: `apps/workers/src/lib/cli.ts`
- Test: `apps/workers/src/lib/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/workers/src/lib/cli.test.ts`:

```ts
import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { commaList, positiveInteger, repoName, unitInterval } from './cli';

/**
 * These four validators replace hand-rolled checks that lived in four different entrypoints and
 * were, between them, wrong three times: `--limit` was `Number()`d with no integer check,
 * `--min-confidence` was never validated at all, and the `owner/name` regex existed only in the
 * icon tool. Commander calls these before any handler runs, so a bad value never reaches a
 * worker.
 */
describe('positiveInteger', () => {
  it('accepts a positive integer', () => {
    expect(positiveInteger('500')).toBe(500);
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects %j', (value) => {
    expect(() => positiveInteger(value)).toThrow(InvalidArgumentError);
  });
});

describe('unitInterval', () => {
  it.each([
    ['0', 0],
    ['0.7', 0.7],
    ['1', 1],
  ])('accepts %j', (value, expected) => {
    expect(unitInterval(value)).toBe(expected);
  });

  it.each(['-0.1', '1.1', '2', 'abc', ''])('rejects %j', (value) => {
    expect(() => unitInterval(value)).toThrow(InvalidArgumentError);
  });
});

describe('repoName', () => {
  it('accepts owner/name', () => {
    expect(repoName('argoproj/argo-cd')).toBe('argoproj/argo-cd');
  });

  it.each(['argo-cd', 'a/b/c', 'owner /name', 'owner/', '/name', ''])('rejects %j', (value) => {
    expect(() => repoName(value)).toThrow(InvalidArgumentError);
  });
});

describe('commaList', () => {
  it('splits on commas', () => {
    expect(commaList('cncf,krew')).toEqual(['cncf', 'krew']);
  });

  it('drops empty entries from a trailing or doubled comma', () => {
    expect(commaList('cncf,,krew,')).toEqual(['cncf', 'krew']);
  });

  it('trims surrounding whitespace', () => {
    expect(commaList('cncf, krew')).toEqual(['cncf', 'krew']);
  });

  it('rejects a value with no entries at all', () => {
    expect(() => commaList(',,')).toThrow(InvalidArgumentError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/workers/src/lib/cli.test.ts`
Expected: FAIL — `Failed to resolve import "./cli"`.

- [ ] **Step 3: Write the implementation**

Create `apps/workers/src/lib/cli.ts`:

```ts
import { InvalidArgumentError } from 'commander';

/**
 * Shared commander pieces for `kecoctl` (AGENTS.md §8).
 *
 * Every validator here runs *before* a handler does, which is the point: a bad `--limit` should
 * fail in argument parsing, not two hours into a sweep. They were previously inline in four
 * entrypoints, in four different states of repair.
 */

export const positiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
};

/** A confidence or share: a real number in [0, 1] inclusive. */
export const unitInterval = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError('must be a number between 0 and 1');
  }
  return parsed;
};

/**
 * `owner/name`, the public identifier used everywhere (§11). Deliberately strict about
 * whitespace: a shell-quoted `"owner /name"` is a typo, not a repo.
 */
export const repoName = (value: string): string => {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new InvalidArgumentError('must be owner/name, e.g. argoproj/argo-cd');
  }
  return value;
};

/** `--seed cncf,krew`. Empty entries are dropped; an all-empty value is an error, not `[]`. */
export const commaList = (value: string): string[] => {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new InvalidArgumentError('must list at least one comma-separated value');
  }
  return entries;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/workers/src/lib/cli.test.ts`
Expected: PASS, 4 describe blocks.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/lib/cli.ts apps/workers/src/lib/cli.test.ts
git commit -m "feat(workers): add shared commander argument validators"
```

---

### Task 2: The `run()` error boundary and the Meilisearch target

**Files:**
- Modify: `apps/workers/src/lib/cli.ts`
- Modify: `apps/workers/src/lib/cli.test.ts`

Commander's `.exitOverride()` makes it throw `CommanderError` instead of calling `process.exit`. That is what lets a test assert on parse failures — but it means the boundary now has to tell three cases apart, because `--help` also arrives as a thrown `CommanderError`.

- [ ] **Step 1: Write the failing test**

Append to `apps/workers/src/lib/cli.test.ts`. **Merge the two import lines into the ones already at the top of the file** rather than adding a second import from `'commander'` and a second from `'./cli'` — so the head of the file becomes:

```ts
import { CommanderError, InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { commaList, positiveInteger, repoName, run, unitInterval } from './cli';
```

Then append:

```ts
/**
 * `.exitOverride()` turns *every* commander exit into a throw, including `--help`, which exits
 * 0 and has already printed. A boundary that logs all three the same way makes `kecoctl --help`
 * report a failure and exit 1 — so the three-way split is the whole behaviour worth testing.
 */
describe('run', () => {
  const silent = { error: () => {}, warn: () => {} };

  it('leaves the exit code alone on success', async () => {
    const exitCode = await run('test', async () => {}, { log: silent });
    expect(exitCode).toBe(0);
  });

  it('treats a displayed help as success and logs nothing', async () => {
    const errors: unknown[] = [];
    const exitCode = await run(
      'test',
      async () => {
        throw new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)');
      },
      { log: { error: (fields) => errors.push(fields), warn: () => {} } },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
  });

  it('adds the pnpm hint to an excess-argument error', async () => {
    const warnings: string[] = [];
    const exitCode = await run(
      'test',
      async () => {
        throw new CommanderError(1, 'commander.excessArguments', 'error: too many arguments');
      },
      { log: { error: () => {}, warn: (_fields, message) => warnings.push(message) } },
    );

    expect(exitCode).toBe(1);
    expect(warnings.join('\n')).toMatch(/drop the `--`/);
  });

  it('reports an ordinary failure with the command name and exits 1', async () => {
    const errors: { err?: string }[] = [];
    const exitCode = await run(
      'test',
      async () => {
        throw new Error('cache is on fire');
      },
      { log: { error: (fields) => errors.push(fields as { err?: string }), warn: () => {} } },
    );

    expect(exitCode).toBe(1);
    expect(errors[0]?.err).toBe('cache is on fire');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/workers/src/lib/cli.test.ts`
Expected: FAIL — `run` is not exported from `./cli`.

- [ ] **Step 3: Write the implementation**

Append to `apps/workers/src/lib/cli.ts`:

```ts
import { Command, CommanderError } from 'commander';
import { TOOLS_INDEX } from '@keco/core';
import { config } from './config';

/**
 * `--host` and `--index` are added to each leaf command rather than declared once on the root,
 * because commander binds a root option before the subcommand name — `kecoctl --index tools
 * index create` reads backwards. The default host comes from `config`, which has already
 * validated MEILI_HOST, so commander never re-reads the environment itself.
 *
 * `TOOLS_INDEX` comes from `@keco/core`, not `TOOLS_ALIAS` from `@keco/search`. They are the
 * same string — `@keco/search`'s settings.ts is literally `export const TOOLS_ALIAS =
 * TOOLS_INDEX` — but `@keco/search`'s entrypoint constructs a Meilisearch client, so importing
 * it here would pull the whole client into `kecoctl --help` and into every worker command that
 * never touches the read model. The wiring layer names indexes; it does not talk to them.
 */
export const withMeiliTarget = (command: Command): Command =>
  command
    .option('-H, --host <url>', 'Meilisearch host', config.MEILI_HOST)
    .option('-i, --index <uid>', 'target index', TOOLS_INDEX);

export type MeiliTarget = { host: string; index: string };

type BoundaryLogger = {
  error(fields: object, message: string): void;
  warn(fields: object, message: string): void;
};

/**
 * The hint commander's generic "too many arguments" message cannot carry.
 *
 * `pnpm -F @keco/workers kecoctl -- repo crawl` forwards the `--` verbatim, and commander
 * treats it as an end-of-options literal: everything after becomes a positional argument
 * (`lib/command.js:1789`). Under the old `node:util` parseArgs this was *silent* — flags were
 * dropped and a two-hour sweep started with defaults. It is now an error, but an error that
 * blames the wrong thing unless we say this.
 */
const EXCESS_ARGUMENTS_HINT =
  'If you invoked this as `pnpm -F @keco/workers kecoctl -- <command>`, drop the `--`; ' +
  'everything after it is treated as a positional argument and the flags are ignored. ' +
  '`mise run <task> -- --flag` is unaffected.';

/**
 * The single error boundary for the CLI. Returns the exit code rather than calling
 * `process.exit`, so it can be tested and so a caller can still let node flush its streams.
 */
export async function run(
  name: string,
  work: () => Promise<void>,
  { log }: { log: BoundaryLogger },
): Promise<number> {
  try {
    await work();
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version have already printed and are not failures. Logging them as errors is
      // how `--help` ends up looking broken.
      if (error.exitCode === 0) return 0;
      if (error.code === 'commander.excessArguments') {
        log.warn({ code: error.code }, EXCESS_ARGUMENTS_HINT);
      }
      // Commander has already written its own message to stderr; repeating it adds noise.
      return error.exitCode;
    }

    log.error({ err: error instanceof Error ? error.message : String(error) }, `${name} failed`);
    return 1;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/workers/src/lib/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -F @keco/workers check
git add apps/workers/src/lib/cli.ts apps/workers/src/lib/cli.test.ts
git commit -m "feat(workers): add the CLI error boundary and Meilisearch target options"
```

---

### Task 3: The command tree, against stub handlers

**Files:**
- Create: `apps/workers/src/cli/program.ts`
- Test: `apps/workers/src/cli/program.test.ts`

This is the task that makes the change worth doing. The tree is built with handlers passed in, so every flag, default and validator is asserted without a cache, a Meilisearch or a network call anywhere.

- [ ] **Step 1: Write the failing test**

Create `apps/workers/src/cli/program.test.ts`:

```ts
import { CommanderError } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, type Handlers } from './program';

/**
 * The argument layer has never had a test, and it has been wrong: `discovery/index.ts` carried
 * a hand-written positional guard because `pnpm … -- --limit 5` silently dropped every flag and
 * started a full sweep with defaults. That case is the last test in this file.
 *
 * Handlers are stubs, so nothing here touches the cache, Meilisearch, GitHub or the filesystem.
 */
const handlerNames = [
  'discoverySweep',
  'repoCrawl',
  'repoAnalyze',
  'repoIcon',
  'project',
  'indexCreate',
  'indexSeed',
  'checkpointReset',
] as const;

let handlers: Handlers;

beforeEach(() => {
  handlers = Object.fromEntries(
    handlerNames.map((name) => [name, vi.fn().mockResolvedValue(undefined)]),
  ) as unknown as Handlers;
});

/** `from: 'user'` means argv without the node/script prefix. */
const parse = (...argv: string[]) =>
  buildProgram(handlers).parseAsync(argv, { from: 'user' });

const optionsPassedTo = (name: (typeof handlerNames)[number]) =>
  vi.mocked(handlers[name]).mock.calls[0]?.[0];

describe('discovery sweep', () => {
  it('defaults query to kubernetes and leaves limit unset', async () => {
    await parse('discovery', 'sweep');
    expect(optionsPassedTo('discoverySweep')).toEqual({
      query: 'kubernetes',
      fresh: false,
      limit: null,
    });
  });

  it('reads --query, --fresh and --limit', async () => {
    await parse('discovery', 'sweep', '--query', 'istio', '--fresh', '--limit', '500');
    expect(optionsPassedTo('discoverySweep')).toEqual({
      query: 'istio',
      fresh: true,
      limit: 500,
    });
  });

  it('rejects a non-positive --limit before the sweep starts', async () => {
    await expect(parse('discovery', 'sweep', '--limit', '0')).rejects.toThrow(CommanderError);
  });
});

describe('repo crawl', () => {
  it('defaults the seeds and the limit', async () => {
    await parse('repo', 'crawl');
    expect(optionsPassedTo('repoCrawl')).toEqual({
      seeds: ['cncf', 'krew'],
      limit: 200,
      repo: null,
    });
  });

  it('splits --seed and drops a trailing comma', async () => {
    await parse('repo', 'crawl', '--seed', 'cncf,krew,');
    expect(optionsPassedTo('repoCrawl')?.seeds).toEqual(['cncf', 'krew']);
  });

  it('validates --repo as owner/name', async () => {
    await expect(parse('repo', 'crawl', '--repo', 'argo-cd')).rejects.toThrow(CommanderError);
  });
});

describe('repo analyze', () => {
  it('leaves every option unset by default', async () => {
    await parse('repo', 'analyze');
    expect(optionsPassedTo('repoAnalyze')).toEqual({
      forceRefresh: null,
      repo: null,
      minConfidence: null,
    });
  });

  it('reads --force-refresh and --min-confidence', async () => {
    await parse('repo', 'analyze', '--force-refresh', 'scorecard', '--min-confidence', '0.7');
    expect(optionsPassedTo('repoAnalyze')).toEqual({
      forceRefresh: 'scorecard',
      repo: null,
      minConfidence: 0.7,
    });
  });

  it('rejects a --min-confidence outside [0, 1]', async () => {
    await expect(parse('repo', 'analyze', '--min-confidence', '2')).rejects.toThrow(CommanderError);
  });
});

describe('repo icon', () => {
  it('requires --repo', async () => {
    await expect(parse('repo', 'icon')).rejects.toThrow(CommanderError);
  });

  it('passes a valid repo through', async () => {
    await parse('repo', 'icon', '--repo', 'ahmetb/kubectx');
    expect(optionsPassedTo('repoIcon')).toEqual({ repo: 'ahmetb/kubectx' });
  });
});

describe('project', () => {
  it('is a top-level command, not a subcommand of index', async () => {
    await parse('project', '--rebuild');
    expect(optionsPassedTo('project')).toEqual({ rebuild: true, batch: 1000 });
  });

  it('defaults to an incremental run', async () => {
    await parse('project');
    expect(optionsPassedTo('project')?.rebuild).toBe(false);
  });
});

describe('index', () => {
  it('create defaults --index to the tools alias and --force-settings to false', async () => {
    await parse('index', 'create');
    expect(optionsPassedTo('indexCreate')).toMatchObject({
      index: 'tools',
      forceSettings: false,
    });
  });

  it('seed carries its three guard flags', async () => {
    await parse('index', 'seed', '--clear', '--force', '--batch', '250');
    expect(optionsPassedTo('indexSeed')).toMatchObject({ clear: true, force: true, batch: 250 });
  });

  it('seed rejects a zero batch', async () => {
    await expect(parse('index', 'seed', '--batch', '0')).rejects.toThrow(CommanderError);
  });
});

describe('checkpoint reset', () => {
  it('requires --consumer', async () => {
    await expect(parse('checkpoint', 'reset')).rejects.toThrow(CommanderError);
  });

  it('rejects a consumer that does not exist', async () => {
    await expect(parse('checkpoint', 'reset', '--consumer', 'bogus')).rejects.toThrow(
      CommanderError,
    );
  });

  it('accepts a known consumer', async () => {
    await parse('checkpoint', 'reset', '--consumer', 'analyzer');
    expect(optionsPassedTo('checkpointReset')).toEqual({ consumer: 'analyzer' });
  });
});

describe('the `--` trap', () => {
  /**
   * The regression test for the bug this whole change exists to fix. Under `node:util`'s
   * parseArgs this parsed to zero options and started a full sweep with defaults; commander
   * turns it into an excess-argument error on every command, not just the one that got burned.
   */
  it('rejects flags smuggled past a -- separator', async () => {
    await expect(parse('discovery', 'sweep', '--', '--limit', '5')).rejects.toThrow(CommanderError);
    expect(handlers.discoverySweep).not.toHaveBeenCalled();
  });

  it('rejects an unknown option rather than ignoring it', async () => {
    await expect(parse('project', '--rebild')).rejects.toThrow(CommanderError);
  });
});

describe('exitOverride inheritance', () => {
  /**
   * Commander copies `_exitCallback` to a child in `copyInheritedSettings`, which runs at
   * `.command()` time — so `.exitOverride()` must be called on the root *before* any subcommand
   * is created. Get the order wrong and subcommand parse errors call `process.exit` directly,
   * killing the test runner instead of failing a test. This asserts the ordering held.
   */
  it('throws from a nested subcommand instead of exiting the process', async () => {
    await expect(parse('index', 'seed', '--batch', 'abc')).rejects.toThrow(CommanderError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/workers/src/cli/program.test.ts`
Expected: FAIL — `Failed to resolve import "./program"`.

- [ ] **Step 3: Write the implementation**

Create `apps/workers/src/cli/program.ts`:

```ts
import { Command, Option } from 'commander';
import { CONSUMERS } from '@keco/core';
import type { AnalyzeOptions } from '../analyzer';
import type { CrawlOptions } from '../crawler';
import type { IconOptions } from '../crawler/icon-run';
import type { DiscoveryOptions } from '../discovery';
import type { ProjectOptions } from '../projector';
import type { CheckpointResetOptions } from '../replay';
import {
  commaList,
  positiveInteger,
  repoName,
  unitInterval,
  withMeiliTarget,
  type MeiliTarget,
} from '../lib/cli';

/**
 * The `kecoctl` command tree (AGENTS.md §8, and the design at
 * docs/superpowers/specs/2026-08-26-workers-cli-design.md).
 *
 * Grouped by noun: the thing being acted on, then the verb. `project` is the one flat command,
 * and its help text says why.
 *
 * Handlers arrive as a parameter rather than an import, which is the entire reason this file is
 * testable: a test builds the tree with stubs and asserts what an argv produces, with no cache,
 * no Meilisearch and no network. The option types below are `import type` only —
 * `verbatimModuleSyntax` erases them, so nothing here pulls a worker in at runtime.
 */

export type IndexCreateOptions = MeiliTarget & { forceSettings: boolean };
export type IndexSeedOptions = MeiliTarget & { batch: number; clear: boolean; force: boolean };

export type Handlers = {
  discoverySweep: (options: DiscoveryOptions) => Promise<void>;
  repoCrawl: (options: CrawlOptions) => Promise<void>;
  repoAnalyze: (options: AnalyzeOptions) => Promise<void>;
  repoIcon: (options: IconOptions) => Promise<void>;
  project: (options: ProjectOptions) => Promise<void>;
  indexCreate: (options: IndexCreateOptions) => Promise<void>;
  indexSeed: (options: IndexSeedOptions) => Promise<void>;
  checkpointReset: (options: CheckpointResetOptions) => Promise<void>;
};

/** Commander reports an absent optional value as `undefined`; every runner wants `null`. */
const orNull = <T>(value: T | undefined): T | null => value ?? null;

export function buildProgram(handlers: Handlers): Command {
  const program = new Command()
    .name('kecoctl')
    .description('Keco write-side CLI — run the pipeline, manage the read model')
    .showHelpAfterError()
    // Must precede every .command() below: commander copies the exit callback into a child at
    // creation time (copyInheritedSettings), so a subcommand created before this line would
    // still call process.exit on a parse error.
    .exitOverride();

  // ── discovery ──────────────────────────────────────────────────────────────
  const discovery = program
    .command('discovery')
    .description('enumerate candidate repos from GitHub Search');

  discovery
    .command('sweep')
    .description('enumerate every repo matching a keyword into discovery/{query}/*.yaml')
    .addHelpText(
      'after',
      '\nOne namespace per keyword, so several keywords can share a cache. Resumes from\n' +
        "discovery/{query}/state.json by default; --fresh starts this keyword's sweep over and\n" +
        'leaves the others alone.\n\n' +
        '--limit stops at the first window boundary past N, so it overshoots. It is a dev-run\n' +
        'convenience, not a budget.\n\n' +
        'Exits 1 if any window failed: a truncated corpus that exits 0 would let a scheduled\n' +
        'sweep hand the crawler a missing star band and call it a success.',
    )
    .option('-q, --query <keyword>', 'keyword to enumerate', 'kubernetes')
    .option('-l, --limit <n>', 'stop after roughly this many repos (overshoots)', positiveInteger)
    .option('--fresh', "start this keyword's sweep over instead of resuming", false)
    .action(async ({ query, limit, fresh }: { query: string; limit?: number; fresh: boolean }) => {
      await handlers.discoverySweep({ query, limit: orNull(limit), fresh });
    });

  // ── repo ───────────────────────────────────────────────────────────────────
  const repo = program.command('repo').description('fetch, classify and illustrate repos');

  repo
    .command('crawl')
    .description('fetch discovered and seeded repos into the cache')
    .addHelpText(
      'after',
      '\nRegistry seeds first (higher signal than keyword search), then the discovery lists.\n' +
        'ETag-conditional on everything: a 304 costs no quota.',
    )
    .option('-s, --seed <list>', 'comma-separated registry seeds', commaList, ['cncf', 'krew'])
    .option('-l, --limit <n>', 'stop after this many repos', positiveInteger, 200)
    .option('-r, --repo <owner/name>', 'crawl a single repo', repoName)
    .action(
      async ({ seed, limit, repo: one }: { seed: string[]; limit: number; repo?: string }) => {
        await handlers.repoCrawl({ seeds: seed, limit, repo: orNull(one) });
      },
    );

  repo
    .command('analyze')
    .description('classify everything with a changed content_hash or an expired signal TTL')
    .addHelpText(
      'after',
      '\n--force-refresh is the only TTL bypass and it is deliberately manual and per-provider:\n' +
        'a blanket bypass turns a replay into a 30k-request storm against Scorecard.',
    )
    .option('-f, --force-refresh <provider>', 'ignore the cache TTL for one signal provider')
    .option('-r, --repo <owner/name>', 'analyze a single repo', repoName)
    .option(
      '-c, --min-confidence <n>',
      're-analyze anything below this confidence (0–1)',
      unitInterval,
    )
    .action(
      async (options: { forceRefresh?: string; repo?: string; minConfidence?: number }) => {
        await handlers.repoAnalyze({
          forceRefresh: orNull(options.forceRefresh),
          repo: orNull(options.repo),
          minConfidence: orNull(options.minConfidence),
        });
      },
    );

  repo
    .command('icon')
    .description("fetch and derive one repo's icon, standalone")
    .addHelpText(
      'after',
      '\nThe crawler will call this pipeline inline once it exists. Until then this runs it for\n' +
        'one repo. It fetches only what is not already cached, so a repo the crawler has already\n' +
        'fetched costs no GitHub quota at all.',
    )
    .addOption(
      new Option('-r, --repo <owner/name>', 'the repo to illustrate')
        .argParser(repoName)
        .makeOptionMandatory(),
    )
    .action(async ({ repo: one }: { repo: string }) => {
      await handlers.repoIcon({ repo: one });
    });

  // ── project ────────────────────────────────────────────────────────────────
  // Flat, not `index project`. It is a journal consumer with a checkpoint; `index create` and
  // `index seed` are operator tools that consume no journal and advance no checkpoint. Nesting
  // it there would put the only legitimate writer to Meilisearch beside a dev-only fixture
  // seeder and imply they are peers (§4).
  program
    .command('project')
    .description('project analyses into Meilisearch — the only writer to the read model')
    .addHelpText(
      'after',
      '\nPure: cache in, index out, no network beyond Meilisearch. --rebuild replays every\n' +
        'analysis from cache into a new index and swaps the alias, with zero GitHub calls.',
    )
    .option('--rebuild', 'full offline replay into a new index, then an alias swap', false)
    .option('-b, --batch <n>', 'documents per upsert batch', positiveInteger, 1000)
    .action(async ({ rebuild, batch }: { rebuild: boolean; batch: number }) => {
      await handlers.project({ rebuild, batch });
    });

  // ── index ──────────────────────────────────────────────────────────────────
  const index = program
    .command('index')
    .description('bootstrap and fill a Meilisearch index (operator tooling)');

  withMeiliTarget(index.command('create'))
    .description('create the index if missing and apply the tools settings — safe on production')
    .addHelpText(
      'after',
      '\nApplies settings only to an index that is missing or empty. A settings change reindexes,\n' +
        'and §5 forbids that on the live alias — build a new index and swap instead.',
    )
    .option(
      '--force-settings',
      'apply settings even to an index that already holds documents (this reindexes it)',
      false,
    )
    .action(async (options: IndexCreateOptions) => {
      await handlers.indexCreate(options);
    });

  withMeiliTarget(index.command('seed'))
    .description('fill the index with the mock corpus — fabricated data, local Meilisearch only')
    .addHelpText(
      'after',
      '\nWrites fabricated repos, scores and install_methods. Rendering a `brew install` line for\n' +
        'a formula that does not exist is the worst bug this project can ship (§6), so a\n' +
        'non-local host is refused unless you type --force.',
    )
    .option('-b, --batch <n>', 'documents per batch', positiveInteger, 500)
    .option('--clear', 'delete every existing document first', false)
    .option('--force', 'allow a non-local Meilisearch host', false)
    .action(async (options: IndexSeedOptions) => {
      await handlers.indexSeed(options);
    });

  // ── checkpoint ─────────────────────────────────────────────────────────────
  const checkpoint = program
    .command('checkpoint')
    .description('inspect and reset journal consumer positions');

  checkpoint
    .command('reset')
    .description('reset a consumer checkpoint so it replays from the beginning')
    .addHelpText(
      'after',
      '\nReplay is normal operation, not an incident (§3): reset the checkpoint and everything\n' +
        'downstream rebuilds from the cache, with zero GitHub calls.',
    )
    .addOption(
      new Option('-c, --consumer <name>', 'the consumer to rewind')
        .choices([...CONSUMERS])
        .makeOptionMandatory(),
    )
    .action(async ({ consumer }: CheckpointResetOptions) => {
      await handlers.checkpointReset({ consumer });
    });

  return program;
}
```

- [ ] **Step 4: Run the test — it should pass immediately**

Run: `pnpm vitest run apps/workers/src/cli/program.test.ts`
Expected: **PASS**, every describe block.

This surprises people, so: vitest transpiles with esbuild and does not typecheck. `import type` statements are erased entirely, so the six worker option types being undeclared costs nothing at runtime — the tree is built from commander, `@keco/core` and `lib/cli.ts`, all of which exist, and the handlers are stubs. Nothing imports a worker.

That is the design working, not a hole in it: the whole command surface is proven before a single worker is touched.

- [ ] **Step 5: Confirm the typechecker disagrees, for now**

Run: `pnpm -F @keco/workers check`
Expected: FAIL — six errors of the form `Module '"../discovery"' has no exported member 'DiscoveryOptions'`, one per worker.

Do not stub those types and do not silence the errors. They are the checklist for Tasks 4–9, and they go green one at a time as each worker is converted.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/cli/program.ts apps/workers/src/cli/program.test.ts
git commit -m "feat(workers): build the kecoctl command tree against injected handlers"
```

`mise run ci` stays red until Task 9, because `check` is part of it. The *test suite* is green throughout. Commit anyway — the tree is the contract, and Tasks 4–9 exist to satisfy it.

---

### Task 4: Convert `discovery`

**Files:**
- Modify: `apps/workers/src/discovery/index.ts:1-52` (imports, header comment, `parseArgs` block) and `:246-256` (the trailing `try/catch`)

- [ ] **Step 1: Remove the argument parsing and export the options type**

In `apps/workers/src/discovery/index.ts`, delete the `import { parseArgs } from 'node:util';` line and the whole `const { values, positionals } = parseArgs({...});` block.

Replace the last paragraph of the file header comment — the one beginning *"Thin by construction"* — so it no longer claims the file is untestable, since that stops being true here:

```ts
 * Thin by construction: the window algebra is `windows.ts`, the split/paginate decision is
 * `plan.ts`, the resume-vs-new-sweep decision is `sweep.ts`, the signal handling is
 * `lib/shutdown.ts`, all persistence is `store.ts`. Argument parsing is `cli/program.ts`, and
 * this module executes nothing on import — it exports `runDiscovery`, which `kecoctl
 * discovery sweep` calls. Anything that carries a decision belongs in one of those modules,
 * and every one of them exists because a bug was found in it.
```

Then add the options type and change the signature:

```ts
export type DiscoveryOptions = {
  query: string;
  /** `null` means no limit. Validated as a positive integer by the CLI. */
  limit: number | null;
  fresh: boolean;
};

export async function runDiscovery({ query, limit, fresh }: DiscoveryOptions): Promise<void> {
```

- [ ] **Step 2: Delete the now-dead validation inside the function**

Delete these three blocks from the body, in this order:

1. The positional-argument guard (`if (positionals.length > 0) { … }`) and its comment. Commander rejects excess arguments on every command now, and `lib/cli.ts`'s `run()` supplies the hint — the guard is the thing this refactor generalises.
2. `const query = values.query!;`
3. The `const limit = …` line and the `if (limit !== null && …) throw` that follows it. `positiveInteger` in `cli/program.ts` runs before the handler.

- [ ] **Step 3: Replace the remaining `values.` references**

There are two: `fresh: values.fresh` in the `DiscoveryStore.open` call, and `fresh: values.fresh` in the `'discovery start'` log object. Both become `fresh`.

- [ ] **Step 4: Replace the trailing runner**

Delete the file's last block:

```ts
try {
  await main();
} catch (error) {
  log.error({ error: error instanceof Error ? error.message : String(error) }, 'discovery failed');
  process.exitCode = 1;
}
```

Nothing replaces it. `run()` in `lib/cli.ts` is the boundary now.

**Leave `process.exitCode = 1` at `index.ts:63` and `:222` exactly as they are.** Those are results, not exceptions: an unauthenticated token and a sweep that finished with failed windows. A truncated corpus that exits 0 is the failure mode `:216-226` exists to prevent.

- [ ] **Step 5: Typecheck**

Run: `pnpm -F @keco/workers check`
Expected: errors only about the *other* not-yet-converted workers' types being imported by `cli/program.ts`. No error mentioning `discovery/index.ts`.

- [ ] **Step 6: Verify the existing discovery tests still pass**

Run: `pnpm vitest run apps/workers/src/discovery`
Expected: PASS — `store.test.ts`, `sweep.test.ts`, `windows.test.ts`, `plan.test.ts` unchanged and green. They never touched `index.ts`, which was the problem.

- [ ] **Step 7: Commit**

```bash
git add apps/workers/src/discovery/index.ts
git commit -m "refactor(discovery): export runDiscovery instead of parsing argv on import"
```

---

### Task 5: Convert `crawler`

**Files:**
- Modify: `apps/workers/src/crawler/index.ts`

- [ ] **Step 1: Remove the argument parsing**

Delete `import { parseArgs } from 'node:util';` and the whole `const { values } = parseArgs({...});` block.

- [ ] **Step 2: Export the options type and convert `main`**

```ts
export type CrawlOptions = {
  seeds: string[];
  limit: number;
  /** Crawl a single repo instead of the seed lists. `null` means the full run. */
  repo: string | null;
};

export async function runCrawler({ seeds, limit, repo }: CrawlOptions): Promise<void> {
  const { journal } = createRuntime();

  log.info(
    { seeds, limit, repo, checkpoint: 'n/a — the crawler is driven by seeds, not a checkpoint' },
    'crawler start',
  );
```

The old body computed `seeds` and `limit` from `values`; both now arrive as parameters, so delete those two lines.

- [ ] **Step 3: Preserve the TODO block verbatim, with one edit**

The `// TODO(crawler): implement, in this order (§4.1): …` block stays exactly as it is, with a single change on the line that reads:

```ts
  //      Until this loop exists, `mise run icon -- --repo owner/name` runs the same pipeline
```

becomes

```ts
  //      Until this loop exists, `mise run repo:icon -- --repo owner/name` runs the same
  //      pipeline
```

Add `void repo;` beside the existing `void ownsShard; void config; void journal;` so the new parameter does not trip `no-unused-vars`.

- [ ] **Step 4: Delete the trailing `await main();`**

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm -F @keco/workers check && pnpm eslint apps/workers/src/crawler`
Expected: no errors mentioning `crawler/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/crawler/index.ts
git commit -m "refactor(crawler): export runCrawler instead of parsing argv on import"
```

---

### Task 6: Convert the icon tool

**Files:**
- Rename: `apps/workers/src/crawler/icon-cli.ts` → `apps/workers/src/crawler/icon-run.ts`

- [ ] **Step 1: Rename the file with git so history follows**

```bash
git mv apps/workers/src/crawler/icon-cli.ts apps/workers/src/crawler/icon-run.ts
```

- [ ] **Step 2: Wrap the top-level script body in an exported function**

The file is currently top-to-bottom script. Replace its header comment and the `parseArgs` + validation block:

```ts
import { repoKeys } from '@keco/cache/keys';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';
import { updateIcon } from './icon';

/**
 * `kecoctl repo icon --repo owner/name` — the icon pipeline, standalone.
 *
 * The crawler is still a stub (AGENTS.md §0), so this exists to prove the pipeline works
 * against real GitHub responses before there is a crawl to run it inside. It fetches only the
 * two documents the pipeline needs, and only when they are not already cached, so running it
 * over a repo the crawler has already fetched costs no GitHub quota at all.
 */
const log = workerLogger('icon');

export type IconOptions = {
  /** Validated as `owner/name` by the CLI before this runs. */
  repo: string;
};

type RepoJson = { default_branch?: string; owner?: { avatar_url?: string } };
type TreeJson = { tree?: { path?: string; type?: string }[] };

/**
 * Deliberately not the `@keco/github` client: that one carries the crawler's quota governor and
 * its pacer, and borrowing them for a one-repo dev command would report misleading budget usage
 * for a crawl that is not happening. Two unconditional requests, only on a cache miss.
 */
const github = async <T>(path: string): Promise<T> => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(config.GITHUB_TOKEN ? { authorization: `Bearer ${config.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
  return (await response.json()) as T;
};

export async function runIcon({ repo }: IconOptions): Promise<void> {
  const { cache } = createRuntime();
  const keys = repoKeys(repo);

  const repoJson =
    (await cache.getJSON<RepoJson>(keys.repo)) ?? (await github<RepoJson>(`/repos/${repo}`));
  const branch = repoJson.default_branch ?? 'main';
  const treeJson =
    (await cache.getJSON<TreeJson>(keys.tree)) ??
    (await github<TreeJson>(`/repos/${repo}/git/trees/${branch}?recursive=1`));
  const readme = (await cache.getText(keys.readme)) ?? '';

  const meta = await updateIcon(
    cache,
    {
      repo,
      defaultBranch: branch,
      avatarUrl: repoJson.owner?.avatar_url ?? null,
      treePaths: (treeJson.tree ?? [])
        .filter((entry) => entry.type === 'blob')
        .map((entry) => entry.path ?? ''),
      readme,
    },
    { fetch: globalThis.fetch },
  );

  log.info({ repo, ...meta }, meta.source === null ? 'no icon' : 'icon updated');
}
```

The `owner/name` regex and the `process.exit(1)` that guarded it are gone — `repoName` in `lib/cli.ts` does that now, before the handler runs, and `makeOptionMandatory()` covers the missing-flag case.

- [ ] **Step 3: Confirm nothing else referenced the old filename**

Run: `grep -rn "icon-cli" --include=*.ts --include=*.json --include=*.toml --include=*.md . | grep -v node_modules`
Expected: only `apps/workers/package.json:9` (removed in Task 12) and `mise.toml` (Task 13). If a `.md` matches, note it for Task 14.

- [ ] **Step 4: Typecheck**

Run: `pnpm -F @keco/workers check`
Expected: no errors mentioning `icon-run.ts`.

- [ ] **Step 5: Verify the icon tests still pass**

Run: `pnpm vitest run apps/workers/src/crawler`
Expected: PASS — `icon.test.ts` and `icon-candidate.test.ts` test `./icon`, not the CLI, so they are unaffected.

- [ ] **Step 6: Commit**

```bash
git add -A apps/workers/src/crawler
git commit -m "refactor(crawler): make the icon tool a runIcon module, not a script"
```

---

### Task 7: Convert `analyzer`

**Files:**
- Modify: `apps/workers/src/analyzer/index.ts`

- [ ] **Step 1: Remove the argument parsing**

Delete `import { parseArgs } from 'node:util';` and the `const { values } = parseArgs({...});` block.

- [ ] **Step 2: Export the options type and convert `main`**

```ts
export type AnalyzeOptions = {
  /** Provider name — the only TTL bypass, and it is manual. `null` honours every TTL. */
  forceRefresh: string | null;
  repo: string | null;
  minConfidence: number | null;
};

export async function runAnalyzer({
  forceRefresh,
  repo,
  minConfidence,
}: AnalyzeOptions): Promise<void> {
  const { journal } = createRuntime();
  const checkpoint = await journal.checkpoint('analyzer');
  log.info(
    { checkpoint: checkpoint.last_event_id, forceRefresh, repo, minConfidence },
    'analyzer start',
  );
```

`repo` and `minConfidence` were parsed but never read before; logging them is the minimum that keeps them honest until the passes land. Add `void repo; void minConfidence;` after the log call if lint complains about unused destructured bindings.

- [ ] **Step 3: Preserve the TODO block verbatim**

The `// TODO(analyzer): implement the three passes (§4.2): …` block and the `NOTE:` paragraph below it are unchanged. Do not reword, reflow or "tidy" them.

- [ ] **Step 4: Delete the trailing `await main();`**

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm -F @keco/workers check && pnpm eslint apps/workers/src/analyzer`
Expected: no errors mentioning `analyzer/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/analyzer/index.ts
git commit -m "refactor(analyzer): export runAnalyzer instead of parsing argv on import"
```

---

### Task 8: Convert `projector`

**Files:**
- Modify: `apps/workers/src/projector/index.ts`

- [ ] **Step 1: Remove the argument parsing**

Delete `import { parseArgs } from 'node:util';` and the `const { values } = parseArgs({...});` block.

- [ ] **Step 2: Export the options type and convert `main`**

```ts
export type ProjectOptions = {
  /** Full offline replay into a new index plus an alias swap, rather than an incremental run. */
  rebuild: boolean;
  batch: number;
};

export async function runProjector({ rebuild, batch }: ProjectOptions): Promise<void> {
  const { journal } = createRuntime();
  const client = createAdminClient();
  const checkpoint = await journal.checkpoint('projector');

  log.info(
    { rebuild, checkpoint: checkpoint.last_event_id, batchSize: batch },
    'projector start',
  );

  if (rebuild) {
```

Note `batchSize: batch` — previously `Number(values.batch)`, which is now done by `positiveInteger` at parse time.

- [ ] **Step 3: Preserve both TODO blocks verbatim**

The rebuild TODO inside the `if` and the long projection TODO in the loop are unchanged, including the `VALIDATE BEFORE YOU UPSERT` paragraph.

- [ ] **Step 4: Delete the trailing `await main();`**

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm -F @keco/workers check && pnpm eslint apps/workers/src/projector`
Expected: no errors mentioning `projector/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/src/projector/index.ts
git commit -m "refactor(projector): export runProjector instead of parsing argv on import"
```

---

### Task 9: Convert `replay`, and make `program.test.ts` green

**Files:**
- Modify: `apps/workers/src/replay/index.ts`

This is the task that closes the loop: with every options type exported, `cli/program.ts` compiles and its whole test file goes green.

- [ ] **Step 1: Rewrite the module**

Replace the entire contents of `apps/workers/src/replay/index.ts`:

```ts
import type { Consumer } from '@keco/core';
import { workerLogger } from '../lib/logger';
import { createRuntime } from '../lib/runtime';

/**
 * `kecoctl checkpoint reset --consumer analyzer` — rewind a consumer (AGENTS.md §3).
 *
 * Replay is normal operation, not an incident: reset the checkpoint and everything downstream
 * rebuilds from the cache, with zero GitHub calls.
 *
 * The directory keeps the name `replay` because replay is the concept §3 names; `checkpoint` is
 * the noun the command operates on.
 */
const log = workerLogger('replay');

export type CheckpointResetOptions = {
  /** Validated against CONSUMERS by commander's `.choices()` before this runs. */
  consumer: Consumer;
};

export async function runCheckpointReset({ consumer }: CheckpointResetOptions): Promise<void> {
  const { journal } = createRuntime();
  const before = await journal.checkpoint(consumer);
  await journal.reset(consumer);

  log.info(
    { consumer, from: before.last_event_id, to: null },
    'checkpoint reset — next run replays from the beginning',
  );
}
```

The `CONSUMERS.includes` check and the `process.exit(1)` are gone: `new Option(…).choices([...CONSUMERS]).makeOptionMandatory()` in `cli/program.ts` rejects both a bad value and a missing flag, and prints the valid choices itself.

- [ ] **Step 2: Run the command-tree test**

Run: `pnpm vitest run apps/workers/src/cli/program.test.ts`
Expected: PASS — every describe block, including `the '--' trap` and `exitOverride inheritance`.

If `exitOverride inheritance` instead *kills the test run* rather than failing, `.exitOverride()` is in the wrong place in `buildProgram` — move it above the first `.command()` call.

- [ ] **Step 3: Typecheck the package**

Run: `pnpm -F @keco/workers check`
Expected: clean. Every `import type` in `cli/program.ts` now resolves.

- [ ] **Step 4: Commit**

```bash
git add apps/workers/src/replay/index.ts
git commit -m "refactor(replay): export runCheckpointReset and let commander validate the consumer"
```

---

### Task 10: Rename `engine/` to `read-model/` and wire the real handlers

**Files:**
- Rename: `apps/workers/src/engine/` → `apps/workers/src/read-model/`
- Delete: `apps/workers/src/engine/cli.ts`
- Create: `apps/workers/src/cli/handlers.ts`

- [ ] **Step 1: Move the directory, dropping the old CLI**

```bash
git mv apps/workers/src/engine apps/workers/src/read-model
git rm apps/workers/src/read-model/cli.ts
```

`create-index.ts`, `seed.ts`, `corpus.ts`, `create-index.test.ts` and `seed.test.ts` move with unchanged content — they import each other relatively and reach outward only for `@keco/search`, `@keco/core` and `@keco/cache`.

- [ ] **Step 2: Update the one stale comment in `corpus.ts`**

`apps/workers/src/read-model/corpus.ts` says *"`src/engine/**` is operator tooling"*. Change that phrase to `src/read-model/**`.

- [ ] **Step 3: Confirm the tests moved intact**

Run: `pnpm vitest run apps/workers/src/read-model`
Expected: PASS — `create-index.test.ts` and `seed.test.ts`, unchanged.

- [ ] **Step 4: Write the real handlers**

Create `apps/workers/src/cli/handlers.ts`:

```ts
import { awaitTask, createAdminClient } from '@keco/search';
import { workerLogger } from '../lib/logger';
import { loadCorpus, MOCK_CORPUS_PATH } from '../read-model/corpus';
import { createIndex, readIndexState } from '../read-model/create-index';
import { assertSeedTarget, seedDocuments } from '../read-model/seed';
import type { Handlers } from './program';

/**
 * The real handlers behind `kecoctl`.
 *
 * Every worker is loaded with a dynamic `import()` rather than a static one. A single static
 * graph would pull `sharp`, the Meilisearch client, the GitHub client and `@keco/analyze` into
 * every invocation — `kecoctl --help` and `kecoctl checkpoint reset` included. Specifiers are
 * extensionless because `moduleResolution` is `bundler` (tsconfig.base.json).
 *
 * The two `index` commands are implemented here rather than in a worker module because they are
 * operator tooling with no worker behind them: they are the whole of what `engine cli.ts` used
 * to be.
 */
const log = workerLogger('engine');

/** Every command talks to one Meilisearch; `--host` overrides MEILI_HOST for a one-off run. */
const clientFor = (host: string) => createAdminClient({ ...process.env, MEILI_HOST: host });

export const handlers: Handlers = {
  discoverySweep: async (options) => (await import('../discovery')).runDiscovery(options),
  repoCrawl: async (options) => (await import('../crawler')).runCrawler(options),
  repoAnalyze: async (options) => (await import('../analyzer')).runAnalyzer(options),
  repoIcon: async (options) => (await import('../crawler/icon-run')).runIcon(options),
  project: async (options) => (await import('../projector')).runProjector(options),
  checkpointReset: async (options) => (await import('../replay')).runCheckpointReset(options),

  indexCreate: async ({ host, index: uid, forceSettings }) => {
    const plan = await createIndex(clientFor(host), uid, forceSettings);

    log.info(
      { index: uid, host, ...plan },
      plan.applySettings ? 'index ready' : 'settings not applied',
    );
    if (!plan.applySettings && !plan.create) {
      // Nothing was broken, but nothing was done either — say so loudly enough to be noticed
      // in a deploy log, and leave the exit code at 0 so a bootstrap step stays idempotent.
      log.warn({ index: uid }, plan.reason);
    }
  },

  indexSeed: async ({ host, index: uid, batch, clear, force }) => {
    assertSeedTarget(host, force);

    const documents = await loadCorpus();
    const client = clientFor(host);

    // Settings are what make a seeded index worth searching — facets, ranking, sorts. Refuse to
    // fill an unconfigured index rather than quietly producing a corpus with none of them.
    if (!(await readIndexState(client, uid)).exists) {
      throw new Error(`no index "${uid}" at ${host} — run \`kecoctl index create\` first`);
    }

    log.info(
      { index: uid, host, documents: documents.length, source: MOCK_CORPUS_PATH, batch },
      'seeding mock corpus',
    );

    if (clear) {
      await awaitTask(client.index(uid).deleteAllDocuments());
      log.info({ index: uid }, 'cleared existing documents');
    }

    const sent = await seedDocuments(documents, {
      batchSize: batch,
      // Await the task, not the enqueue: a resolved `addDocuments` only means Meilisearch
      // accepted the batch, and a failed task after that would go unnoticed (§5, §14).
      submit: (chunk) => awaitTask(client.index(uid).addDocuments(chunk)),
      onBatch: (batchNumber, documentsSent) =>
        log.debug(
          { batch: batchNumber, sent: documentsSent, of: documents.length },
          'batch indexed',
        ),
    });

    const stats = await client.index(uid).getStats();
    log.info(
      { index: uid, sent, documentsInIndex: stats.numberOfDocuments },
      'mock corpus seeded — fabricated data, never a production index',
    );
  },
};
```

- [ ] **Step 5: Typecheck**

Run: `pnpm -F @keco/workers check`
Expected: clean. `Handlers` in `program.ts` and the object here must agree — a mismatch here is the type error that catches a renamed option.

- [ ] **Step 6: Commit**

```bash
git add -A apps/workers/src
git commit -m "refactor(workers): rename engine to read-model and wire the real CLI handlers"
```

---

### Task 11: The entrypoint

**Files:**
- Create: `apps/workers/src/cli.ts`

- [ ] **Step 1: Write it**

```ts
import { run } from './lib/cli';
import { workerLogger } from './lib/logger';
import { handlers } from './cli/handlers';
import { buildProgram } from './cli/program';

/**
 * `kecoctl` — the entire write side, one CLI (AGENTS.md §8).
 *
 * Six lines on purpose. The tree is `cli/program.ts`, the loading is `cli/handlers.ts`, the
 * error boundary is `lib/cli.ts`. Nothing decided here means nothing untestable here.
 */
process.exitCode = await run('kecoctl', () => buildProgram(handlers).parseAsync(), {
  log: workerLogger('kecoctl'),
});
```

`process.exitCode` rather than `process.exit()`: an immediate exit can truncate pino's buffered output, and the discovery sweep sets its own non-zero code for a completed-but-incomplete run.

- [ ] **Step 2: Verify help renders and loads nothing heavy**

Run: `cd apps/workers && pnpm exec node --import tsx src/cli.ts --help`
Expected: the eight commands under `discovery`, `repo`, `project`, `index`, `checkpoint`. Exit code 0 — check with `echo $?`.

- [ ] **Step 3: Verify a subcommand's help carries the prose**

Run: `pnpm exec node --import tsx src/cli.ts discovery sweep --help`
Expected: the `--limit … overshoots` and `Exits 1 if any window failed` paragraphs.

- [ ] **Step 4: Verify the `--` trap fails loudly**

Run: `pnpm exec node --import tsx src/cli.ts discovery sweep -- --limit 5; echo "exit=$?"`
Expected: commander's `error: too many arguments`, the `drop the '--'` hint on stderr, and a non-zero exit. **No sweep starts.**

- [ ] **Step 5: Verify a real command still works end to end**

Requires a running Meilisearch (`mise run infra:up`).

Run: `pnpm exec node --import tsx src/cli.ts index create`
Expected: `index ready`, or the "already holds N documents" warning at exit 0 if it is populated. Either is a pass; a stack trace is not.

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add apps/workers/src/cli.ts
git commit -m "feat(workers): add the kecoctl entrypoint"
```

---

### Task 12: One npm script — and the guard that keeps it safe

**Files:**
- Modify: `apps/workers/package.json:6-15`
- Create: `apps/workers/src/cli/entrypoint.test.ts`

Read `apps/workers/src/lib/shutdown.ts:28-33` before this task. Six scripts use the plain `tsx` CLI; exactly one — `discovery` — uses `node --import tsx`, because the tsx CLI is a supervisor that kills its child ~110ms after a group signal, far short of the ~500ms a 50k-repo flush needs. One script for eight commands means the safest invocation has to win.

- [ ] **Step 1: Write the failing test**

Create `apps/workers/src/cli/entrypoint.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A test about a package.json string, which looks absurd until you read
 * `src/lib/shutdown.ts:28-33`.
 *
 * The `tsx` CLI is a supervisor: it spawns the real process as a child and tears it down about
 * 110ms after a group signal, far short of the ~500ms a 50k-repo discovery flush takes (~950ms
 * at 100k). Under it, no shutdown handler can win and Ctrl-C silently discards the entire
 * sweep — no state file, no repos-full-list.yaml, only orphaned detail files. As a *loader*
 * (`node --import tsx`) there is one process and the signal reaches the handler directly.
 *
 * When seven scripts became one, this stopped being discovery's private concern and became the
 * property of every command. Nothing else would catch a regression: it produces no error, no
 * failing test and no log line — just a sweep that quietly stops persisting.
 */
describe('the kecoctl npm script', () => {
  it('runs tsx as a loader, never as the supervising CLI', async () => {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.kecoctl).toBe('node --import tsx src/cli.ts');
  });

  it('has no leftover per-worker scripts', async () => {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(Object.keys(manifest.scripts).sort()).toEqual(['check', 'kecoctl']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/workers/src/cli/entrypoint.test.ts`
Expected: FAIL — `scripts.kecoctl` is `undefined`.

- [ ] **Step 3: Replace the scripts block**

In `apps/workers/package.json`, replace lines 6–15 with:

```json
  "scripts": {
    "check": "tsc --noEmit",
    "kecoctl": "node --import tsx src/cli.ts"
  },
```

`node --import tsx`, not `tsx` — see the test's comment, and `src/lib/shutdown.ts:28-33`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/workers/src/cli/entrypoint.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/workers/package.json apps/workers/src/cli/entrypoint.test.ts
git commit -m "refactor(workers): collapse seven npm scripts into one kecoctl entrypoint"
```

---

### Task 13: Close the lint boundary hole

**Files:**
- Modify: `eslint.config.mjs:104-117`

`apps/workers/src/cli/**` sits outside every existing `files` glob, so without a rule it is the one file tree in the repo that can reach `@keco/search` and its master key with nothing stopping it.

- [ ] **Step 1: Add the rule**

In `eslint.config.mjs`, immediately after the existing `// Only the projector writes to Meilisearch.` block (which is unchanged), add:

```js
  // The CLI layer composes runners; it does not do work. The day it imports @keco/search
  // directly is the day it has started doing work — and it sits outside every glob above, so
  // without this rule it is the one place in apps/workers with no boundary at all.
  //
  // src/cli/handlers.ts is the deliberate exception: the two `index` commands are operator
  // tooling with no worker behind them, so it holds the admin client the way engine/cli.ts did.
  {
    files: ['apps/workers/src/cli/program.ts', 'apps/workers/src/cli.ts'],
    rules: boundary(
      'apps/workers/src/cli wiring may import worker runners and commander — never a worker\'s own dependencies (§7).',
      [['@keco/search', '@keco/github', '@keco/signals', '@keco/analyze']],
    ),
  },
```

The glob names two files rather than `src/cli/**` because `handlers.ts` legitimately holds the Meilisearch admin client — it absorbed `engine/cli.ts`, which always had it. Naming the two constrained files is honest; a `**` glob with an inline `eslint-disable` in `handlers.ts` would say the rule does not really apply.

- [ ] **Step 2: Verify the rule is live**

Temporarily add `import { TOOLS_ALIAS } from '@keco/search';` to the top of `apps/workers/src/cli/program.ts`, then run:

Run: `pnpm eslint apps/workers/src/cli/program.ts`
Expected: `no-restricted-imports` error quoting the §7 message.

Remove the temporary import.

- [ ] **Step 3: Run the full lint**

Run: `pnpm eslint .`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(lint): bound the workers CLI layer to runners and commander"
```

---

### Task 14: `mise.toml`

**Files:**
- Modify: `mise.toml` — the `icon`, `discovery`, `crawler`, `analyzer`, `projector`, `replay`, `rebuild`, `pipeline`, `engine`, `engine:index`, `engine:seed` and `mock` tasks

Long prose descriptions move into commander (done in Task 3), so these shrink to one line plus a pointer.

- [ ] **Step 1: Replace the `[tasks.icon]` block**

```toml
[tasks."repo:icon"]
description = "Fetch and derive one repo's icon, standalone. `kecoctl repo icon --help` for details. Args: --repo owner/name"
run = "pnpm -F @keco/workers kecoctl repo icon"
```

- [ ] **Step 2: Replace the four worker tasks**

Replace the `[tasks.discovery]`, `[tasks.crawler]`, `[tasks.analyzer]` and `[tasks.projector]` blocks with:

```toml
[tasks."discovery:sweep"]
description = "Enumerate every GitHub repo matching a keyword into discovery/{query}/*.yaml. Resumes by default. `kecoctl discovery sweep --help` for the full contract. Args: --query kubernetes --fresh --limit 500"
run = "pnpm -F @keco/workers kecoctl discovery sweep"

[tasks."repo:crawl"]
description = "Fetch discovered and seeded repos into the cache. Args: --seed cncf,krew --limit 200 --repo owner/name"
run = "pnpm -F @keco/workers kecoctl repo crawl"

[tasks."repo:analyze"]
description = "Classify everything with a changed content_hash or an expired signal TTL. Args: --force-refresh scorecard"
run = "pnpm -F @keco/workers kecoctl repo analyze"

[tasks.project]
description = "Project analyses into Meilisearch — the only writer to the read model. Args: --rebuild for a full replay + alias swap"
run = "pnpm -F @keco/workers kecoctl project"
```

- [ ] **Step 3: Replace `[tasks.replay]`**

```toml
[tasks."checkpoint:reset"]
description = "Reset a consumer checkpoint so it replays from the beginning. Args: --consumer analyzer"
run = "pnpm -F @keco/workers kecoctl checkpoint reset"
```

- [ ] **Step 4: Rewire `rebuild` and `pipeline`**

They keep their names — they are convenience compositions, not one of the eight operations.

```toml
[tasks.rebuild]
description = "Full offline rebuild of the read model from cache (no GitHub calls)"
run = "pnpm -F @keco/workers kecoctl project --rebuild"

[tasks.pipeline]
description = "Small end-to-end run: crawl 200 seeded repos, analyze, project"
run = [
  "pnpm -F @keco/workers kecoctl repo crawl --seed cncf,krew --limit 200",
  "pnpm -F @keco/workers kecoctl repo analyze",
  "pnpm -F @keco/workers kecoctl project",
]
```

- [ ] **Step 5: Replace the three `engine` tasks**

```toml
[tasks.kecoctl]
description = "The write-side CLI. `mise run kecoctl -- --help` lists every command"
run = "pnpm -F @keco/workers kecoctl"

[tasks."index:create"]
description = "Create the target index with the real tools settings. Idempotent, and safe on production: it refuses to reindex an index that already holds documents unless --force-settings. Args: --index tools --host URL"
run = "pnpm -F @keco/workers kecoctl index create"

[tasks."index:seed"]
description = "Fill the index with infra/mock/corpus.json — fabricated data, local Meilisearch only. Args: --index tools --batch 500 --clear --force"
depends = ["mock:corpus"]
run = "pnpm -F @keco/workers kecoctl index seed"
```

Also update the section heading comment above them from `# ── read-model engine + mock corpus ──` to `# ── read model + mock corpus ──`.

- [ ] **Step 6: Rewire `[tasks.mock]`**

```toml
[tasks.mock]
description = "Local search sandbox: create the index and fill it with the mock corpus, so Meilisearch itself can be exercised before the projector exists"
run = [
  "mise run index:create",
  "mise run index:seed -- --clear",
]
```

- [ ] **Step 7: Verify every task resolves**

Run: `mise tasks`
Expected: `discovery:sweep`, `repo:crawl`, `repo:analyze`, `repo:icon`, `project`, `index:create`, `index:seed`, `checkpoint:reset`, `kecoctl` all listed. No `discovery`, `crawler`, `analyzer`, `projector`, `replay`, `icon`, `engine`, `engine:index` or `engine:seed`.

- [ ] **Step 8: Verify argument forwarding still works through mise**

Run: `mise run kecoctl -- repo analyze --help`
Expected: the analyze help, including the `--force-refresh` paragraph. This is the path the old `--` trap comment says is safe; confirm it still is.

- [ ] **Step 9: Verify the mock sandbox end to end**

Requires Meilisearch (`mise run infra:up`).

Run: `mise run mock`
Expected: index created, corpus emitted by `mock:corpus`, documents seeded, and a final `mock corpus seeded` line reporting a non-zero `documentsInIndex`.

- [ ] **Step 10: Commit**

```bash
git add mise.toml
git commit -m "chore(mise): rename worker tasks to the kecoctl vocabulary"
```

---

### Task 15: Documentation

**Files:**
- Modify: `AGENTS.md` §4.2 (the crawler's icon reference), §7 (layout tree), §8 (command table)

- [ ] **Step 1: Update the §7 layout tree**

In the `keco/` tree, replace the workers line:

```text
│   └── workers/
│       └── src/{cli,discovery,crawler,analyzer,projector,replay,read-model,lib}/
```

- [ ] **Step 2: Add a sentence to §7 explaining the CLI layer**

Immediately after the paragraph beginning **"Three deployables, two of them static."**, add:

```markdown
**`apps/workers` is one CLI, `kecoctl`.** Eight commands grouped by noun — `discovery sweep`,
`repo crawl|analyze|icon`, `project`, `index create|seed`, `checkpoint reset` — over a
three-layer split: `src/cli/program.ts` builds the command tree and takes its handlers as a
parameter, `src/cli/handlers.ts` supplies them as lazy imports, and each worker module exports
`run*(options)` and executes nothing on import. That last property is the point: argument
parsing used to be six hand-rolled `parseArgs` blocks that no test could reach, and one of them
silently dropped every flag after a `--`.
```

- [ ] **Step 3: Rewrite the §8 command table rows**

Replace these rows in the table:

| Old row | New row |
| --- | --- |
| `mise run discovery -- --query kubernetes --fresh` | `mise run discovery:sweep -- --query kubernetes --fresh` |
| `mise run crawler -- --seed cncf,krew --limit 200` | `mise run repo:crawl -- --seed cncf,krew --limit 200` |
| `mise run analyzer` | `mise run repo:analyze` |
| `mise run analyzer -- --force-refresh scorecard` | `mise run repo:analyze -- --force-refresh scorecard` |
| `mise run projector` | `mise run project` |
| `mise run replay -- --consumer analyzer` | `mise run checkpoint:reset -- --consumer analyzer` |
| `mise run engine -- --help` | `mise run kecoctl -- --help` — the write-side CLI; every command takes `--help` |
| `mise run engine:index` | `mise run index:create` |
| `mise run engine:seed` | `mise run index:seed` |

Update the `mise run engine` row's description to: *"The write-side CLI (`apps/workers/src/cli`, commander): `discovery sweep`, `repo crawl|analyze|icon`, `project`, `index create|seed`, `checkpoint reset`. Every index command takes `--host` and `--index`."*

Add a row that was never in the table, between `repo:crawl` and `repo:analyze`:

| `mise run repo:icon -- --repo owner/name` | Fetch and derive one repo's icon, standalone — the pipeline the crawler will call inline |

- [ ] **Step 4: Update the §4 projector paragraph**

In §4, the sentence beginning *"The one exception is `engine seed` (`apps/workers/src/engine`)"* becomes:

```markdown
  exception is `kecoctl index seed` (`apps/workers/src/read-model`), dev-only tooling that
  pushes `infra/mock/corpus.json` into a local index so the search engine can be exercised
  before the projector fills it: it consumes no journal, advances no checkpoint and writes only
  sentinel-stamped fixtures. It refuses a non-local `MEILI_HOST` (§8).
```

- [ ] **Step 5: Sweep for every remaining stale reference**

Run:

```bash
grep -rn "mise run \(discovery\|crawler\|analyzer\|projector\|replay\|icon\|engine\)\b\|engine:index\|engine:seed\|src/engine\|icon-cli" \
  --include=*.md --include=*.ts --include=*.toml --include=*.json . | grep -v node_modules
```

Expected: matches only inside `docs/superpowers/specs/*.md`. Those are historical records of what was decided when and are left alone — **except** `docs/superpowers/specs/2026-08-26-workers-cli-design.md`, which is this change's own spec and correctly describes the new state.

Fix anything else the grep finds.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md
git commit -m "docs: describe kecoctl in AGENTS.md §4, §7 and §8"
```

---

### Task 16: Full verification

- [ ] **Step 1: Run the gate**

Run: `mise run ci`
Expected: `check`, `lint`, `test` and `taxonomy:check` all green.

- [ ] **Step 2: Confirm no module executes on import**

Run:

```bash
grep -rn "^await main()\|^await run\|parseArgs" apps/workers/src --include=*.ts
```

Expected: no matches at all. `parseArgs` is gone from the package; the only top-level `await` is in `src/cli.ts`, which is the entrypoint and does not match these patterns.

- [ ] **Step 3: Walk every command's help**

```bash
cd apps/workers
for cmd in "discovery sweep" "repo crawl" "repo analyze" "repo icon" "project" "index create" "index seed" "checkpoint reset"; do
  echo "=== $cmd ==="
  pnpm exec node --import tsx src/cli.ts $cmd --help || echo "FAILED: $cmd"
done
```

Expected: eight help screens, no `FAILED` line.

- [ ] **Step 4: Confirm the discovery exit code survived**

Run: `cd apps/workers && pnpm exec node --import tsx src/cli.ts discovery sweep --limit 1; echo "exit=$?"`

Without a `GITHUB_TOKEN` this must log `GITHUB_TOKEN is required for discovery` and print `exit=1` — the `index.ts:63` path. With a token it starts a real sweep; Ctrl-C it and confirm it logs `interrupted — flushing artifacts` and writes state, which is the `node --import tsx` property from Task 12 working.

- [ ] **Step 5: Confirm the portal is untouched**

Run: `mise run build`
Expected: green, including `assert:no-mocks`. Nothing in this change reaches `apps/web`, and this proves it.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "refactor(workers): finish the kecoctl CLI migration"
```

---

## Definition of done

Copied from the spec §9, each mapped to the task that satisfies it:

1. `mise run ci` green — Task 16 Step 1.
2. Every command behaves as the task it replaces, including `discovery`'s exit code 1 on failed windows — Task 4 Step 4, Task 16 Step 4.
3. `kecoctl --help` lists all eight commands; each carries the prose that used to live in `mise.toml` — Task 11 Steps 2–3, Task 16 Step 3.
4. `kecoctl discovery sweep -- --limit 5` fails loudly with the `--` hint — Task 11 Step 4, plus the regression test in Task 3.
5. No worker module executes anything on import — Task 16 Step 2.
6. AGENTS.md §4, §7 and §8 updated — Task 15.

Plus one the spec added late: the `kecoctl` script runs `node --import tsx`, guarded by a test — Task 12.
