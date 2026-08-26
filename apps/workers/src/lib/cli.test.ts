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
