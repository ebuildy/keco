import { describe, expect, it } from 'vitest';
import { classifyDerived, type DerivedInput } from './derived';

/** Fixed so maturity's date arithmetic is deterministic. */
const NOW = new Date('2026-08-01T00:00:00.000Z');

const base: DerivedInput = {
  owner: 'acme',
  owner_type: 'Organization',
  license_spdx: 'Apache-2.0',
  readme: '# thing\n\nA thing.',
  tree: ['README.md', 'main.go'],
  archived: false,
  created_at: '2020-01-01T00:00:00.000Z',
  pushed_at: '2026-07-01T00:00:00.000Z',
  latest_release_at: '2026-06-01T00:00:00.000Z',
  landscape: null,
};

describe('license_class', () => {
  it('buckets the common SPDX ids', () => {
    const of = (spdx: string | null) => classifyDerived({ ...base, license_spdx: spdx }, NOW).license_class;
    expect(of('Apache-2.0')).toBe('permissive');
    expect(of('MIT')).toBe('permissive');
    expect(of('MPL-2.0')).toBe('weak-copyleft');
    expect(of('AGPL-3.0')).toBe('copyleft');
    expect(of('BUSL-1.1')).toBe('source-available');
    expect(of('Unlicense')).toBe('public-domain');
  });

  it('does not confuse the Boost licence with the Business Source Licence', () => {
    expect(classifyDerived({ ...base, license_spdx: 'BSL-1.0' }, NOW).license_class).toBe('permissive');
  });

  it('is unknown for a missing or unrecognised licence', () => {
    expect(classifyDerived({ ...base, license_spdx: null }, NOW).license_class).toBe('unknown');
    expect(classifyDerived({ ...base, license_spdx: 'NOASSERTION' }, NOW).license_class).toBe('unknown');
  });
});

describe('openness', () => {
  it('is fully-open for an OSI licence with no commercial markers', () => {
    expect(classifyDerived(base, NOW).openness).toBe('fully-open');
  });

  it('is open-core when the tree carries an enterprise directory', () => {
    const input = { ...base, tree: [...base.tree, 'enterprise/server.go'] };
    expect(classifyDerived(input, NOW).openness).toBe('open-core');
  });

  it('is open-core when the README advertises a commercial edition', () => {
    const input = { ...base, readme: '# thing\n\nSee the Enterprise Edition for SSO.' };
    expect(classifyDerived(input, NOW).openness).toBe('open-core');
  });

  it('is open-core when the README advertises a business edition', () => {
    // Real miss: Portainer is Zlib-licensed with no enterprise/ directory, but its README
    // says "Portainer Business" — the sole surviving signal for that split.
    const input = { ...base, readme: '# Portainer\n\nSee Portainer Business Edition for RBAC and support.' };
    expect(classifyDerived(input, NOW).openness).toBe('open-core');
  });

  it('is source-available for a restricted licence regardless of markers', () => {
    const input = { ...base, license_spdx: 'BUSL-1.1' };
    expect(classifyDerived(input, NOW).openness).toBe('source-available');
  });

  it('is unknown when the licence is unknown', () => {
    expect(classifyDerived({ ...base, license_spdx: null }, NOW).openness).toBe('unknown');
  });
});

describe('maturity', () => {
  const of = (patch: Partial<DerivedInput>) => classifyDerived({ ...base, ...patch }, NOW).maturity;

  it('prefers the CNCF level when the landscape lists it', () => {
    expect(of({ landscape: { cncf_level: 'graduated', org_type: 'foundation' } })).toBe('cncf-graduated');
    expect(of({ landscape: { cncf_level: 'incubating', org_type: null } })).toBe('cncf-incubating');
    expect(of({ landscape: { cncf_level: 'sandbox', org_type: null } })).toBe('cncf-sandbox');
  });

  it('reports archived', () => {
    expect(of({ archived: true })).toBe('archived');
  });

  it('reports archived even when the landscape still lists a CNCF level', () => {
    // opentracing/opentracing-go and rkt/rkt are both archived on GitHub today while still
    // recorded at `incubating` in CNCF history — a cached landscape seed has no obligation
    // to track CNCF's retirement bookkeeping in lockstep. GitHub's archived flag is fresher
    // and stronger evidence, so it must win over a landscape entry that can lag.
    expect(of({ archived: true, landscape: { cncf_level: 'incubating', org_type: 'foundation' } })).toBe(
      'archived',
    );
  });

  it('reports dormant after a year with no push', () => {
    expect(of({ pushed_at: '2025-01-01T00:00:00.000Z' })).toBe('dormant');
  });

  it('reports young under a year old', () => {
    expect(of({ created_at: '2026-03-01T00:00:00.000Z' })).toBe('young');
  });

  it('reports established when over a year old and still released recently', () => {
    expect(of({})).toBe('established');
  });

  it('reports established on a recent push even with no releases at all', () => {
    // Plenty of controllers ship via floating container tags and never cut a release.
    expect(of({ latest_release_at: null })).toBe('established');
    expect(of({ latest_release_at: '2024-01-01T00:00:00.000Z' })).toBe('established');
  });

  it('reports established between one and two years old', () => {
    expect(of({ created_at: '2025-01-01T00:00:00.000Z' })).toBe('established');
  });

  it('is unknown when it is over a year old, quiet for months, and unreleased', () => {
    // Neither clearly alive nor clearly dormant — the honest residual.
    expect(of({ pushed_at: '2026-01-01T00:00:00.000Z', latest_release_at: null })).toBe('unknown');
  });

  it('reports established on the release alone when the push is not recent', () => {
    // pushed_at ~250 days ago: not dormant (<365) but not "recently pushed" (>183) either.
    // Only latest_release_at, ~200 days ago, keeps this established — proving the
    // release-only branch of `releasedRecently || pushedRecently` actually pulls its weight.
    expect(
      of({ pushed_at: '2025-11-24T00:00:00.000Z', latest_release_at: '2026-01-13T00:00:00.000Z' }),
    ).toBe('established');
  });

  it('is unknown rather than a guess when a timestamp fails to parse', () => {
    expect(of({ pushed_at: 'not-a-date' })).toBe('unknown');
    expect(of({ created_at: 'not-a-date' })).toBe('unknown');
  });

  it('is unknown rather than "young" when created_at is in the future (clock skew)', () => {
    // A negative age would otherwise satisfy `age < 365` and be confidently reported young.
    expect(of({ created_at: '2027-01-01T00:00:00.000Z' })).toBe('unknown');
  });
});

describe('governance', () => {
  const of = (patch: Partial<DerivedInput>) => classifyDerived({ ...base, ...patch }, NOW).governance;

  it('recognises the upstream Kubernetes organisations', () => {
    expect(of({ owner: 'kubernetes' })).toBe('foundation');
    expect(of({ owner: 'kubernetes-sigs' })).toBe('foundation');
    expect(of({ owner: 'Kubernetes-Client' })).toBe('foundation');
  });

  it('reads the organisation type from the landscape', () => {
    expect(of({ landscape: { cncf_level: null, org_type: 'foundation' } })).toBe('foundation');
    expect(of({ landscape: { cncf_level: null, org_type: 'vendor' } })).toBe('vendor-backed');
    expect(of({ landscape: { cncf_level: null, org_type: 'community' } })).toBe('community');
  });

  it('calls a personal account individual', () => {
    expect(of({ owner_type: 'User' })).toBe('individual');
  });

  it('is unknown for an organisation with no landscape entry', () => {
    // An org account alone proves nothing about who steers the project.
    expect(of({})).toBe('unknown');
  });
});
