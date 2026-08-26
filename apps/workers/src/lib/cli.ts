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
