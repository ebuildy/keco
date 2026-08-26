import { CommanderError, InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { commaList, positiveInteger, repoName, run, unitInterval } from './cli';

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
