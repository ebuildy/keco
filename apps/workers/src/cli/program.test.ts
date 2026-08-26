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
