import { CommanderError, type Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../lib/config';
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
  'discoveryCount',
  'discoveryList',
  'discoveryReset',
  'repoCrawl',
  'repoAnalyze',
  'repoIcon',
  'repoHistory',
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
/**
 * Half of these cases are deliberate parse failures, and commander writes its usage and error
 * text straight to the real stdout/stderr on the way to throwing — so a fully passing run still
 * printed several screens of help into the CI log. Silence it at every level: `configureOutput`
 * is copied into a subcommand by `copyInheritedSettings` at `.command()` time, which has already
 * happened by the time `buildProgram` returns, so setting it on the root alone would leave every
 * leaf still writing.
 */
const silenceOutput = (command: Command): Command => {
  command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const child of command.commands) silenceOutput(child);
  return command;
};

const parse = (...argv: string[]) =>
  silenceOutput(buildProgram(handlers)).parseAsync(argv, { from: 'user' });

// Generic on `K`, with an explicit return type, rather than the plain union so each call site
// narrows to that one handler's option type — `optionsPassedTo('repoCrawl')` returns
// `CrawlOptions | undefined`, not a union of every handler's options. A non-generic signature
// (or an inferred return type, which resolves the indexed access eagerly against the whole
// union before `K` is substituted) type-checks the body once against all eight and throws away
// the exact type a caller actually wants.
const optionsPassedTo = <K extends (typeof handlerNames)[number]>(
  name: K,
): Parameters<Handlers[K]>[0] | undefined => vi.mocked(handlers[name]).mock.calls[0]?.[0];

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

describe('discovery count | list | reset', () => {
  it('parses count with no flags', async () => {
    await parse('discovery', 'count');
    expect(optionsPassedTo('discoveryCount')).toEqual({ query: null, json: false });
  });

  it('parses count --query', async () => {
    await parse('discovery', 'count', '--query', 'istio');
    expect(optionsPassedTo('discoveryCount')).toMatchObject({ query: 'istio' });
  });

  it('defaults list to runs', async () => {
    await parse('discovery', 'list');
    expect(optionsPassedTo('discoveryList')).toEqual({
      target: 'runs',
      query: null,
      limit: 20,
      sort: null,
      json: false,
    });
  });

  it('accepts repos as the list target', async () => {
    await parse('discovery', 'list', 'repos', '--limit', '5');
    expect(optionsPassedTo('discoveryList')).toMatchObject({ target: 'repos', limit: 5 });
  });

  it('rejects a list target that is neither runs nor repos', async () => {
    await expect(parse('discovery', 'list', 'nonsense')).rejects.toThrow();
  });

  it('parses reset flags, defaulting to keeping the run history', async () => {
    await parse('discovery', 'reset', '--query', 'istio');
    expect(optionsPassedTo('discoveryReset')).toEqual({
      query: 'istio',
      all: false,
      includeRuns: false,
      yes: false,
    });
  });

  it('parses reset --all --include-runs --yes', async () => {
    await parse('discovery', 'reset', '--all', '--include-runs', '--yes');
    expect(optionsPassedTo('discoveryReset')).toEqual({
      query: null,
      all: true,
      includeRuns: true,
      yes: true,
    });
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

  it('rejects a malformed --repo', async () => {
    await expect(parse('repo', 'crawl', '--repo', 'owner/name/extra')).rejects.toThrow(CommanderError);
    await expect(parse('repo', 'crawl', '--repo', 'owner /name')).rejects.toThrow(CommanderError);
  });

  it('passes a valid owner/name --repo through', async () => {
    await parse('repo', 'crawl', '--repo', 'argoproj/argo-cd');
    expect(optionsPassedTo('repoCrawl')).toMatchObject({ repo: 'argoproj/argo-cd' });
  });

  it('passes a bare org --repo through too, unlike repo analyze/icon', async () => {
    await parse('repo', 'crawl', '--repo', 'argoproj');
    expect(optionsPassedTo('repoCrawl')).toMatchObject({ repo: 'argoproj' });
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

describe('repo history', () => {
  it('parses repo history', async () => {
    await parse('repo', 'history', '--limit', '5', '--json');
    expect(optionsPassedTo('repoHistory')).toEqual({ limit: 5, json: true });
  });

  it('defaults repo history to 20 rows of table output', async () => {
    await parse('repo', 'history');
    expect(optionsPassedTo('repoHistory')).toEqual({ limit: 20, json: false });
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
  it('create defaults --host to config.MEILI_HOST, --index to the tools alias and --force-settings to false', async () => {
    await parse('index', 'create');
    expect(optionsPassedTo('indexCreate')).toMatchObject({
      host: config.MEILI_HOST,
      index: 'tools',
      forceSettings: false,
    });
  });

  it('create reads --host and --index', async () => {
    await parse(
      'index',
      'create',
      '--host',
      'http://meili.internal:7700',
      '--index',
      'tools_20260101',
    );
    expect(optionsPassedTo('indexCreate')).toMatchObject({
      host: 'http://meili.internal:7700',
      index: 'tools_20260101',
    });
  });

  it('create reads the short forms -H and -i', async () => {
    await parse('index', 'create', '-H', 'http://meili.internal:7700', '-i', 'tools_20260101');
    expect(optionsPassedTo('indexCreate')).toMatchObject({
      host: 'http://meili.internal:7700',
      index: 'tools_20260101',
    });
  });

  it('seed defaults --batch to 500, --clear to false and --force to false', async () => {
    await parse('index', 'seed');
    expect(optionsPassedTo('indexSeed')).toMatchObject({
      batch: 500,
      clear: false,
      force: false,
    });
  });

  it('seed reads --host and --index', async () => {
    await parse(
      'index',
      'seed',
      '--host',
      'http://meili.internal:7700',
      '--index',
      'tools_20260101',
    );
    expect(optionsPassedTo('indexSeed')).toMatchObject({
      host: 'http://meili.internal:7700',
      index: 'tools_20260101',
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
