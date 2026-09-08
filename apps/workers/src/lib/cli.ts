import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { TOOLS_INDEX } from '@keco/core';
import { config } from './config';

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

/**
 * A confidence or share: a real number in [0, 1] inclusive.
 *
 * `Number('')` and `Number(' ')` both coerce to `0`, which the range check alone would accept
 * as a valid flag value — so an empty or blank string is rejected explicitly before the range
 * check ever runs.
 */
export const unitInterval = (value: string): number => {
  if (value.trim() === '') {
    throw new InvalidArgumentError('must be a number between 0 and 1');
  }
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

/**
 * `owner/name` or a bare `owner` — the crawl command's `--repo`, and only that command's. A
 * repo ref crawls exactly one repo; a bare org (`worklist.ts`'s `isOrgRef`) means "every repo
 * already discovered under this org." Deliberately not `repoName`: `repo analyze` and `repo
 * icon` operate on exactly one repo, so they keep the strict check — this validator exists only
 * where "an org" is a legitimate answer, and a stray typo like `repoOrOrg('argocd')` for what
 * was meant to be `argoproj/argo-cd` fails loudly later (an unknown org matches zero discovered
 * repos) rather than being caught here, which is the one real cost of loosening it.
 */
export const repoOrOrg = (value: string): string => {
  if (!/^[^/\s]+(\/[^/\s]+)?$/.test(value)) {
    throw new InvalidArgumentError('must be owner/name or an org, e.g. argoproj/argo-cd or argoproj');
  }
  return value;
};

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
 * treats it as an end-of-options literal: everything after becomes a positional argument.
 * Under the old `node:util` parseArgs this was *silent* — flags were dropped and a two-hour
 * sweep started with defaults. It is now an error, but an error that blames the wrong thing
 * unless we say this.
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
    // Not a bare `0`. A worker can report failure without throwing: `runDiscovery` sets
    // `process.exitCode = 1` and returns normally when the token is missing, or when a sweep
    // finished with failed windows — a truncated corpus is a *result*, and the run still has
    // artifacts worth flushing, so it is deliberately not an exception. `cli.ts` assigns this
    // return value straight onto `process.exitCode`, so returning 0 here would overwrite that
    // signal and tell a scheduled sweep it had succeeded.
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
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
