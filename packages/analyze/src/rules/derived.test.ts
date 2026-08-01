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
