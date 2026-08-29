# `kecoctl` — one CLI for `apps/workers` — design

**Date:** 2026-08-26
**Status:** approved, not implemented
**Touches:** `apps/workers`, `mise.toml`, `eslint.config.mjs`, `AGENTS.md`

`apps/workers` has seven entrypoints. Six parse their own arguments with `node:util`'s
`parseArgs`; one — `engine` — is a real commander program. This generalises commander across
the whole app: one root command, `kecoctl`, grouped by noun, with every worker reachable from
one `--help`.

## 0. Why, precisely

The duplication is not the interesting part. The interesting part is that **none of the
argument handling is testable**, and it has already been wrong in production.

`apps/workers/src/discovery/index.ts` says so in its own header comment:

> This file executes `main()` on import, so nothing declared here can be unit-tested — anything
> that carries a decision belongs in one of those modules, and every one of them exists because
> a bug was found in it.

Directly below that comment sits a decision that is *not* in one of those modules: a
hand-written guard (`index.ts:39-52`) that rejects positional arguments, because
`pnpm -F @keco/workers discovery -- --limit 5` parses to zero options under `parseArgs` and
silently starts a full two-hour sweep with every flag dropped. The guard exists on exactly one
of the six `parseArgs` entrypoints — the one where somebody got burned.

So this change is only incidentally about commander. It is about moving argument parsing into a
layer that has no side effects on import, and therefore can have tests. Commander is what that
layer is built from, and it fixes the specific trap above for free: `_allowExcessArguments` is
`false` by default in commander 15 (`lib/command.js:29`), and `--` pushes its remainder into
operands (`lib/command.js:1789`), so the flags-silently-dropped case becomes a hard error on
every command rather than a guard on one.

## 1. Command tree

```
kecoctl
├── discovery sweep    --query --fresh --limit
├── repo crawl         --seed --limit --repo
├── repo analyze       --force-refresh --repo --min-confidence
├── repo icon          --repo
├── project            --rebuild --batch
├── index create       --host --index --force-settings
├── index seed         --host --index --batch --clear --force
└── checkpoint reset   --consumer
```

Grouped by noun: the thing being acted on, then the verb.

### `project` is flat, deliberately

Its noun is the index, so `index project` would be the consistent spelling. It is not, because
grouping it there puts the *only* legitimate writer to Meilisearch (AGENTS.md §4) beside a
dev-only fixture seeder and implies they are peers. They have opposite blast radii:
`index seed` refuses a non-local host, and `project` is the thing a production deploy runs.

`project` is a journal consumer with a checkpoint. `index create` and `index seed` are operator
tools that consume no journal and advance no checkpoint — the distinction AGENTS.md §4 already
draws when it names `engine seed` an exception to "the projector is the only writer". The tree
reflects that rather than flattening it. The reason is stated in the command's own help text so
it is not folklore.

### Renames that follow

- `src/engine/` → `src/read-model/`. The word `engine` stops existing in the interface;
  `read-model` is AGENTS.md §5's own term for what the directory manages. `create-index.ts`,
  `seed.ts`, `corpus.ts` and their tests move unchanged. `engine/cli.ts` is deleted — its
  wiring moves into the shared program, its `positiveInteger` and `withTarget` helpers into
  `lib/cli.ts`.
- `src/replay/` keeps its name although the command is `checkpoint reset`. Replay is the
  concept AGENTS.md §3 names ("Replay is normal operation, not an incident"); `checkpoint` is
  the noun the command operates on. The directory follows the concept.
- `src/crawler/icon-cli.ts` → `src/crawler/icon-run.ts`, exporting `runIcon(options)`. It stops
  being a CLI; it becomes the implementation behind `repo icon`.

## 2. Three layers

```
src/cli.ts              entrypoint  — buildProgram(handlers).parseAsync(), inside run()
src/cli/program.ts      wiring      — names, flags, validators, help. No worker imports.
src/cli/handlers.ts     loading     — one lazy `await import()` per command
src/<worker>/index.ts   work        — exported run*(options), nothing executed on import
```

### `src/cli/program.ts`

```ts
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

export function buildProgram(handlers: Handlers): Command;
```

Handlers are a parameter, not an import. That is the whole reason this file is testable: a test
builds the tree with stubs and asserts what a given `argv` produces, with no cache, no
Meilisearch and no network anywhere near it.

The option types are `import type`-only from each worker module. `verbatimModuleSyntax` is on,
so those erase completely — `program.ts` has no runtime dependency on any worker.

`.exitOverride()` is called on the root **before** any subcommand is created. Commander copies
`_exitCallback` to a child in `copyInheritedSettings` (`lib/command.js:105`), which runs at
`.command()` time, so the order matters and a test pins it.

### `src/cli/handlers.ts`

One lazy loader per command:

```ts
export const handlers: Handlers = {
  repoCrawl: async (options) => (await import('../crawler')).runCrawler(options),
  // …
};
```

Lazy because a single static import graph would pull `sharp`, `meilisearch`, `@keco/analyze`
and the GitHub client into every invocation — `kecoctl --help` and `kecoctl checkpoint reset`
included. Extensionless specifiers are correct here: `moduleResolution` is `bundler`
(`tsconfig.base.json`).

### Worker modules

Each loses its `parseArgs` block and its trailing `await main()`, and gains an exported
`run*(options)` plus an exported options type. No top-level execution, no `process.exit`.

Exit codes are the one behaviour that must survive verbatim: `discovery` sets
`process.exitCode = 1` when a sweep completes with failed windows (`index.ts:216-226`), because
a truncated corpus that exits 0 lets a scheduled sweep hand the crawler a missing star band and
call it a success. That is a *result*, not a thrown error, so `runDiscovery` keeps setting
`process.exitCode` itself. Everything else throws and lets the boundary decide.

## 3. `src/lib/cli.ts` — the shared pieces

| Export | Replaces |
|---|---|
| `positiveInteger` | `engine/cli.ts:25-31` |
| `unitInterval` | nothing — `--min-confidence` is unvalidated today |
| `repoName` | the `/^[^/\s]+\/[^/\s]+$/` check in `icon-cli.ts:21` |
| `commaList` | `values.seed!.split(',').filter(Boolean)` in `crawler/index.ts` |
| `withMeiliTarget` | `engine/cli.ts`'s `withTarget` |
| `run(name, fn)` | four different hand-rolled `try`/`catch`/`exit` blocks |

`--consumer` uses commander's own `new Option('-c, --consumer <name>').choices([...CONSUMERS])
.makeOptionMandatory()`, which replaces the manual validation and `process.exit(1)` in
`replay/index.ts:22-24`. `CONSUMERS` is `readonly`, hence the spread.

### `run(name, fn)`

The single error boundary. With `.exitOverride()` active, commander throws `CommanderError`
instead of exiting, so the boundary must distinguish three cases:

1. `commander.helpDisplayed` / `commander.version` — exit `0`, log nothing. Help is not an
   error, and a boundary that logs it as one makes `--help` look broken.
2. `commander.excessArguments` — exit with commander's own code, and append the hint that the
   generic message cannot carry: *if you invoked this as `pnpm -F @keco/workers kecoctl --
   <command>`, drop the `--`; everything after it is treated as a positional argument.* This is
   the `discovery/index.ts:39-52` guard, generalised to all eight commands and stated once.
3. Anything else — `log.error({ err }, '<name> failed')`, exit `1`.

## 4. Closing the lint hole

`eslint.config.mjs:105-117` restricts `@keco/search` to the projector by *directory*:

```js
files: [
  'apps/workers/src/discovery/**/*.ts',
  'apps/workers/src/crawler/**/*.ts',
  'apps/workers/src/analyzer/**/*.ts',
],
```

A new `apps/workers/src/cli/**` sits outside every one of those globs, so without a rule it
would be the one file in the repo that can reach the write key with nothing stopping it. The
existing projector-only rule is unchanged; a new block is added:

> `apps/workers/src/cli` is wiring: it may import worker runners and commander, never a
> worker's dependencies (§7).

barring `@keco/search`, `@keco/github`, `@keco/signals` and `@keco/analyze` from
`apps/workers/src/cli/**`. The invariant is real and worth enforcing: the CLI layer composes
runners, it does not do work, and the day it imports `@keco/search` directly is the day it has
started doing work.

## 5. Tests

`apps/workers` is not the portal, so §13's e2e requirement does not apply. What applies is that
the decisions moving into this layer are the ones that have been wrong before.

**`src/cli/program.test.ts`** — build with stub handlers, `parseAsync(argv, { from: 'user' })`,
assert the options object each handler receives:

- `discovery sweep --query istio --fresh` → `{ query: 'istio', fresh: true, limit: null }`
- `discovery sweep --limit 0` → rejects
- `repo crawl --seed cncf,krew,` → `{ seeds: ['cncf', 'krew'] }` (the trailing empty is dropped)
- `repo analyze --force-refresh scorecard --min-confidence 0.7` → parsed and coerced
- `repo analyze --min-confidence 2` → rejects
- `repo icon --repo not-a-repo` → rejects; `--repo` omitted → rejects as mandatory
- `project --rebuild` → `{ rebuild: true, batch: 1000 }`
- `index seed --batch 0` → rejects
- `checkpoint reset --consumer bogus` → rejects with the known consumers listed
- `discovery sweep -- --limit 5` → rejects as excess arguments (**the regression test for the
  bug that motivated this change**)
- `.exitOverride()` is inherited: a subcommand's parse error throws rather than exiting

**`src/lib/cli.test.ts`** — the validators in isolation: `positiveInteger`, `unitInterval`,
`repoName`, `commaList`, and `run()`'s three-way exit-code branch.

**`src/cli/entrypoint.test.ts`** — asserts `apps/workers/package.json`'s `kecoctl` script starts
with `node --import tsx`, for the reason in §6. Guards an invariant whose violation is
otherwise completely silent.

**Unchanged:** `read-model/seed.test.ts` and `read-model/create-index.test.ts` move with the
directory and are not edited. Every existing worker test (`discovery/*.test.ts`,
`crawler/icon*.test.ts`, `projector/icon.test.ts`, `lib/*.test.ts`) is untouched — this change
does not reach into the work, only into how it is invoked.

## 6. `mise.toml`

Tasks rename to the CLI's vocabulary, one name per operation:

| Was | Becomes |
|---|---|
| `discovery` | `discovery:sweep` |
| `crawler` | `repo:crawl` |
| `analyzer` | `repo:analyze` |
| `icon` | `repo:icon` |
| `projector` | `project` |
| `replay` | `checkpoint:reset` |
| `engine` | `kecoctl` (raw passthrough) |
| `engine:index` | `index:create` |
| `engine:seed` | `index:seed` |

`rebuild`, `pipeline` and `mock` keep their names and are rewired to the new commands; they are
convenience compositions, not one of the eight operations. `mise run analyzer -- --force-refresh
scorecard` becomes `mise run repo:analyze -- --force-refresh scorecard`.

The long prose descriptions currently living in mise task descriptions — the `discovery` one is
a full paragraph explaining that `--limit` overshoots — move into commander `.description()`
and `.addHelpText()`, next to the flags they explain. mise descriptions shrink to one line each
plus a pointer to `kecoctl <command> --help`. Documentation about a flag belongs where the flag
is declared; keeping it in a task runner means it is invisible to anyone running the binary.

### The one script must be `node --import tsx`

`apps/workers/package.json` collapses seven scripts to two: `check`, and

```json
"kecoctl": "node --import tsx src/cli.ts"
```

**Not `tsx src/cli.ts`.** Today six scripts use the plain `tsx` CLI and exactly one —
`discovery` (`package.json:10`) — uses `node --import tsx`. That asymmetry is load-bearing, and
`lib/shutdown.ts:28-33` spells out why:

> The tsx CLI is a supervisor that spawns the real process as a child and tears it down about
> 110ms after it receives a group signal — measured, and far short of the ~500ms a 50k-repo
> flush takes (~950ms at 100k). Under the CLI no handler can win, however patient it is; as a
> loader there is only one process and the signal reaches this code directly. **If a worker
> with durable state is ever switched back to plain `tsx`, Ctrl-C silently starts discarding
> work again.**

One script for eight commands means the *safest* invocation wins, not the most common one.
`node --import tsx` is correct for all eight and load-bearing for one; the reverse choice
breaks `discovery sweep`'s crash-safety with no error, no test failure and no log line — the
sweep just quietly stops persisting on Ctrl-C.

Because the failure is invisible, it gets a guard rather than a comment:
`src/cli/entrypoint.test.ts` reads `package.json` and asserts the `kecoctl` script still starts
with `node --import tsx`. That is a strange-looking test, which is exactly why it needs the
comment explaining that a passing suite is not evidence here.

## 7. Documentation

- **AGENTS.md §8** — the command table is rewritten against the new task names. The `engine`
  rows collapse into `index:create` / `index:seed` / `kecoctl`.
- **`crawler/index.ts:52`** — the TODO block's "Until this loop exists, `mise run icon -- --repo
  owner/name` runs the same pipeline" becomes `mise run repo:icon`. This is the *only* place
  that task is named outside `mise.toml`; AGENTS.md never mentions it, and §8's table does not
  list it either. Add it to that table while rewriting it — a task nobody documented is a task
  nobody finds.
- **AGENTS.md §7** — the layout tree gains `src/cli/`.
- **`docs/superpowers/specs/2026-08-24-project-icons-design.md`** references `mise run icon`;
  it is a historical spec and is left alone. Specs record what was decided when.

No ADR. This reverses nothing in AGENTS.md — §8 does not specify how the workers parse
arguments, and the CQRS contract is untouched, with §4's write-side boundary now enforced by
one more lint rule than before.

## 8. Out of scope

- The `keco` end-user CLI (`keco search ingress`, `keco install k9s`) reserved by
  ROADMAP.md:119. `kecoctl` is named to stay clear of it: this one drives the pipeline, that
  one queries the read model, and they share no code path.
- Implementing any worker. `crawler`, `analyzer` and `projector` remain the stubs they are
  today; this change moves their argument handling and nothing else. Their TODO blocks are
  preserved verbatim.
- A `--dry-run` flag, a `--shard` flag, or any option not already parsed today. New options are
  new features; this is a refactor with tests attached.

## 9. Definition of done

1. `mise run ci` green — check, lint, test, taxonomy:check.
2. Every command in §1 runs and produces the same behaviour as the task it replaces, including
   `discovery`'s exit code 1 on failed windows.
3. `kecoctl --help` lists all eight commands; each `<command> --help` carries the prose that
   used to live in `mise.toml`.
4. `kecoctl discovery sweep -- --limit 5` fails loudly with the `--` hint.
5. No worker module executes anything on import.
6. AGENTS.md §4, §7 and §8 updated in the same change.
