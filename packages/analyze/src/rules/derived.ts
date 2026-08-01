import { aliasesFor } from '@keco/core';

/**
 * Pass 1 — the four derived families (AGENTS.md §4.2, §6). Everything here is computed from
 * data already in the cache: no network, no LLM, no guesses.
 *
 * The governing rule is the one §4.2 already applies to a missing Scorecard: absence of
 * evidence is `unknown`, never a positive claim. `openness` in particular makes a public
 * statement about someone's project, so it is promoted only when the evidence is there.
 */
export type LandscapeEntry = {
  /** CNCF maturity level; null for a project listed without one. */
  cncf_level: 'graduated' | 'incubating' | 'sandbox' | null;
  /** How the landscape records the owning organisation. */
  org_type: 'foundation' | 'vendor' | 'community' | null;
};

export type DerivedInput = {
  owner: string;
  owner_type: 'Organization' | 'User';
  /** SPDX id from the cached repo.json, e.g. "Apache-2.0". Null when GitHub reports none. */
  license_spdx: string | null;
  readme: string;
  tree: string[];
  archived: boolean;
  created_at: string;
  pushed_at: string;
  latest_release_at: string | null;
  /**
   * Lookup into the cached CNCF landscape seed. Null when the seed is absent *or* the repo
   * is not listed — the rules must not distinguish the two, so a missing seed degrades
   * exactly like an unlisted project.
   */
  landscape: LandscapeEntry | null;
};

export type DerivedVerdict = {
  license_class: string;
  openness: string;
  maturity: string;
  governance: string;
};

/** Every value this module can emit. Asserted against taxonomy.yaml by pinning.test.ts. */
export const DECLARED_DERIVED = {
  license_class: ['permissive', 'weak-copyleft', 'copyleft', 'source-available', 'public-domain', 'unknown'],
  openness: ['fully-open', 'open-core', 'source-available', 'unknown'],
  maturity: [
    'cncf-graduated',
    'cncf-incubating',
    'cncf-sandbox',
    'established',
    'young',
    'dormant',
    'archived',
    'unknown',
  ],
  governance: ['foundation', 'vendor-backed', 'community', 'individual', 'unknown'],
} as const;

/** Upstream organisations that are foundation-governed by definition. */
const FOUNDATION_OWNERS = new Set(['kubernetes', 'kubernetes-sigs', 'kubernetes-client', 'cncf']);

/** A directory that exists to hold the paid edition. */
const ENTERPRISE_PATH = /^(ee|enterprise|pro)\//;
const ENTERPRISE_README = /enterprise edition|enterprise version|commercial license|commercial edition/i;

const DAY_MS = 86_400_000;
const daysSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / DAY_MS;

export function classifyLicenseClass(spdx: string | null): string {
  if (spdx === null) return 'unknown';
  return aliasesFor('license_class').get(spdx.toLowerCase()) ?? 'unknown';
}

export function classifyOpenness(input: DerivedInput): string {
  const licenseClass = classifyLicenseClass(input.license_spdx);
  if (licenseClass === 'source-available') return 'source-available';
  // No licence, no claim. This is the majority case for small repos and it must stay silent.
  if (licenseClass === 'unknown') return 'unknown';

  const commercial =
    input.tree.some((path) => ENTERPRISE_PATH.test(path)) || ENTERPRISE_README.test(input.readme);
  return commercial ? 'open-core' : 'fully-open';
}

/**
 * Bands must cover the domain. An earlier draft made `established` require >2 years old AND
 * a release within 6 months, which dropped every 1-2 year old project — and every older one
 * that ships via floating container tags rather than cutting GitHub releases — into
 * `unknown`. That is a hole in the definitions, not missing evidence, and it breaks the
 * contract that `unknown` means "we genuinely could not tell".
 *
 * What is left in `unknown` now is the honest case: over a year old, quiet for six to twelve
 * months, no recent release. Neither clearly alive nor clearly dormant.
 */
export function classifyMaturity(input: DerivedInput, now: Date): string {
  if (input.landscape?.cncf_level) return `cncf-${input.landscape.cncf_level}`;
  if (input.archived) return 'archived';
  if (daysSince(input.pushed_at, now) > 365) return 'dormant';

  const age = daysSince(input.created_at, now);
  if (age < 365) return 'young';

  const releasedRecently =
    input.latest_release_at !== null && daysSince(input.latest_release_at, now) <= 365;
  const pushedRecently = daysSince(input.pushed_at, now) <= 183;
  if (releasedRecently || pushedRecently) return 'established';

  return 'unknown';
}

export function classifyGovernance(input: DerivedInput): string {
  if (FOUNDATION_OWNERS.has(input.owner.toLowerCase())) return 'foundation';

  switch (input.landscape?.org_type) {
    case 'foundation':
      return 'foundation';
    case 'vendor':
      return 'vendor-backed';
    case 'community':
      return 'community';
    default:
      break;
  }

  if (input.owner_type === 'User') return 'individual';

  // An organisation account with no landscape entry proves nothing about who steers it.
  return 'unknown';
}

export function classifyDerived(input: DerivedInput, now: Date = new Date()): DerivedVerdict {
  return {
    license_class: classifyLicenseClass(input.license_spdx),
    openness: classifyOpenness(input),
    maturity: classifyMaturity(input, now),
    governance: classifyGovernance(input),
  };
}
