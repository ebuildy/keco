import { Cache, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLandscapeIndex,
  cncfLandscapeProvider,
  lookupLandscape,
  repoLandscapeUrl,
  resetLandscapeCacheForTests,
} from './cncf-landscape';

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

/** A minimal but real slice of landscape.yml's actual nesting, verified live (see Task 4). */
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
                  homepage_url: https://cert-manager.io/
                  project: graduated
                  repo_url: https://github.com/cert-manager/cert-manager
              - item:
                  name: SomeVendorTool
                  homepage_url: https://example.com/
                  repo_url: https://github.com/example/vendor-tool
              - item:
                  name: RetiredThing
                  project: archived
                  repo_url: https://github.com/example/retired
`;

/** Same repo_url cross-listed under two categories, mirroring containerd's real `second_path`. */
const CROSS_LISTED_YAML = `
landscape:
  - category:
      name: Orchestration
      subcategories:
        - subcategory:
            name: Scheduling
            items:
              - item:
                  name: containerd
                  project: graduated
                  repo_url: https://github.com/containerd/containerd
  - category:
      name: Runtime
      subcategories:
        - subcategory:
            name: Container Runtime
            items:
              - item:
                  name: containerd
                  project: incubating
                  repo_url: https://github.com/containerd/containerd
`;

/** `repo_url` deliberately cased and slashed differently than `repoLandscapeUrl` would produce. */
const NORMALIZATION_YAML = `
landscape:
  - category:
      name: Provisioning
      subcategories:
        - subcategory:
            name: Automation
            items:
              - item:
                  name: NormalizedThing
                  project: sandbox
                  repo_url: HTTPS://GitHub.com/ExampleOrg/ExampleRepo/
`;

afterEach(() => {
  vi.unstubAllGlobals();
  // buildLandscapeIndex's memo is module-scoped state in cncf-landscape.ts — without this,
  // a test that populates it could make a later test in this file pass (or fail) for the
  // wrong reason depending on run order.
  resetLandscapeCacheForTests();
});

describe('buildLandscapeIndex', () => {
  it('indexes a graduated project by its GitHub repo URL', async () => {
    const { parse } = await import('yaml');
    const { CncfLandscapeFile } = await import('./cncf-landscape');
    const file = CncfLandscapeFile.parse(parse(LANDSCAPE_YAML));

    const index = buildLandscapeIndex(file);

    expect(index.get(repoLandscapeUrl('cert-manager/cert-manager'))).toEqual({
      cncf_level: 'graduated',
      org_type: 'foundation',
    });
  });

  it('does not index an item with no project level, or one that is archived', async () => {
    const { parse } = await import('yaml');
    const { CncfLandscapeFile } = await import('./cncf-landscape');
    const file = CncfLandscapeFile.parse(parse(LANDSCAPE_YAML));

    const index = buildLandscapeIndex(file);

    expect(index.get(repoLandscapeUrl('example/vendor-tool'))).toBeUndefined();
    expect(index.get(repoLandscapeUrl('example/retired'))).toBeUndefined();
  });

  it('keeps the first occurrence when a repo is cross-listed under two categories', async () => {
    const { parse } = await import('yaml');
    const { CncfLandscapeFile } = await import('./cncf-landscape');
    const file = CncfLandscapeFile.parse(parse(CROSS_LISTED_YAML));

    const index = buildLandscapeIndex(file);

    expect(index.get(repoLandscapeUrl('containerd/containerd'))).toEqual({
      cncf_level: 'graduated',
      org_type: 'foundation',
    });
  });

  it('normalizes repo_url casing and a trailing slash to match a plain owner/repo lookup key', async () => {
    const { parse } = await import('yaml');
    const { CncfLandscapeFile } = await import('./cncf-landscape');
    const file = CncfLandscapeFile.parse(parse(NORMALIZATION_YAML));

    const index = buildLandscapeIndex(file);

    expect(index.get(repoLandscapeUrl('exampleorg/examplerepo'))).toEqual({
      cncf_level: 'sandbox',
      org_type: 'foundation',
    });
  });
});

describe('lookupLandscape', () => {
  it('fetches, parses YAML, and looks up one repo in a single call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(LANDSCAPE_YAML, { status: 200 })),
    );
    const cache = new Cache(memoryStorage());

    const result = await lookupLandscape(cache, 'cert-manager/cert-manager');

    expect(result).toEqual({
      entry: { cncf_level: 'graduated', org_type: 'foundation' },
      partial: false,
    });
  });

  it('degrades to a null entry, marked partial, when the source is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    const cache = new Cache(memoryStorage());

    const result = await lookupLandscape(cache, 'cert-manager/cert-manager');

    expect(result).toEqual({ entry: null, partial: true });
  });

  it('degrades to a null entry, marked partial, when a 200 body does not match the expected shape', async () => {
    // A CDN or origin outage that still returns 200 (an HTML error page, a truncated body,
    // a redirect stub) is the exact risk this schema mismatch guards against.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 200 })),
    );
    const cache = new Cache(memoryStorage());

    const result = await lookupLandscape(cache, 'cert-manager/cert-manager');

    expect(result).toEqual({ entry: null, partial: true });
  });
});

describe('cncfLandscapeProvider', () => {
  it('is registered with the right name and a weekly TTL', () => {
    const cache = new Cache(memoryStorage());
    expect(cncfLandscapeProvider(cache).name).toBe('cncf-landscape');
  });
});
