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
