import { CommanderError, InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { positiveInteger, repoName, repoOrOrg, run, unitInterval } from './cli';

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

describe('repoOrOrg', () => {
  it('accepts owner/name, exactly like repoName', () => {
    expect(repoOrOrg('argoproj/argo-cd')).toBe('argoproj/argo-cd');
  });

  it('also accepts a bare org, unlike repoName', () => {
    expect(repoOrOrg('argoproj')).toBe('argoproj');
    expect(() => repoName('argoproj')).toThrow(InvalidArgumentError);
  });

  it.each(['a/b/c', 'owner /name', 'owner/', '/name', 'org name', ''])('rejects %j', (value) => {
    expect(() => repoOrOrg(value)).toThrow(InvalidArgumentError);
  });
});

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

  /**
   * A worker can report failure WITHOUT throwing, and two of them do.
   *
   * `runDiscovery` sets `process.exitCode = 1` and returns normally when the token is missing
   * or when a sweep completed with failed windows — those are *results* (a truncated corpus),
   * not exceptions, and the sweep still has artifacts worth flushing. Returning a bare 0 from
   * the success path erased that: `cli.ts` assigns this return value straight onto
   * `process.exitCode`, so a scheduled sweep that silently dropped an entire star band reported
   * success to its orchestrator. That is precisely the failure `discovery/index.ts:196-206`
   * exists to prevent, and the boundary was undoing it.
   */
  it('preserves an exit code the work set on itself without throwing', async () => {
    const before = process.exitCode;
    try {
      const exitCode = await run(
        'test',
        async () => {
          process.exitCode = 1;
        },
        { log: silent },
      );

      expect(exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
  });

  it('still reports 0 when nothing set an exit code', async () => {
    const before = process.exitCode;
    try {
      process.exitCode = 0;
      expect(await run('test', async () => {}, { log: silent })).toBe(0);
    } finally {
      process.exitCode = before;
    }
  });

  /**
   * This is the branch that actually fires in production. Commander's `_callParseArg` catches
   * every `InvalidArgumentError` thrown by our own validators — `positiveInteger`, `repoName`,
   * and so on — at real parse time and rewraps it into exactly this shape: a `CommanderError`
   * with `code: 'commander.invalidArgument'` and `exitCode: 1`. So a mistyped `--limit 0` does
   * not take the "ordinary failure" path above; it takes this one. Commander has already
   * printed its own "error: option ... is invalid" message to stderr, which is why the
   * fallthrough must stay silent — a future edit that started logging here would double every
   * bad-flag message a user sees, and nothing but this test would notice.
   */
  it('stays silent on the fallthrough branch for an ordinary commander parse error', async () => {
    const errors: unknown[] = [];
    const warnings: unknown[] = [];
    const exitCode = await run(
      'test',
      async () => {
        throw new CommanderError(
          1,
          'commander.invalidArgument',
          "error: option '-l, --limit <n>' argument '0' is invalid. must be a positive integer",
        );
      },
      {
        log: {
          error: (fields) => errors.push(fields),
          warn: (fields) => warnings.push(fields),
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
