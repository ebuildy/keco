import type { Cache } from '@keco/cache';
import { z } from 'zod';
import { DAY, Provider } from '../provider';

export * from './scorecard';

/**
 * The remaining providers of AGENTS.md §4.2. Each is a thin adapter with a fixed TTL and
 * a hard timeout, and each response lands in `external/{provider}/{key}.json`.
 *
 * Bulk over per-repo wherever the provider allows it: fetching Homebrew's formula.json
 * once per corpus run is right, fetching it per repo is 30k requests for the same file.
 */

/** deps.dev — project metadata, a Scorecard mirror, dependent counts across ecosystems. */
export const DepsDevResponse = z.object({
  projectKey: z.object({ id: z.string() }).optional(),
  scorecard: z.unknown().optional(),
  dependentCount: z.number().optional(),
  starsCount: z.number().optional(),
});

export const depsDevProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'depsdev',
      ttlSeconds: 7 * DAY,
      timeoutMs: 8_000,
      schema: DepsDevResponse,
      // key is `owner/repo`
      request: (key) => ({ url: `https://api.deps.dev/v3/projects/github.com%2F${key.replace('/', '%2F')}` }),
    },
    cache,
  );

/** OSV.dev — known vulnerabilities affecting the project. */
export const OsvResponse = z.object({
  vulns: z.array(z.object({ id: z.string(), summary: z.string().optional() })).default([]),
});

export const osvProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'osv',
      ttlSeconds: 3 * DAY,
      timeoutMs: 8_000,
      schema: OsvResponse,
      // key is a package name; the analyzer supplies it from the manifests it parsed.
      request: (key) => ({
        url: 'https://api.osv.dev/v1/query',
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ package: { name: key } }),
        },
      }),
    },
    cache,
  );

/**
 * Homebrew — one bulk file for the whole corpus, fetched under the fixed key `all`.
 * Formula names rarely match repo names (`ahmetb/kubectx` → `kubectx`), so membership is
 * checked against this file rather than guessed (§14).
 */
export const BrewFormulae = z.array(
  z.object({
    name: z.string(),
    full_name: z.string(),
    homepage: z.string().optional(),
    desc: z.string().nullable().optional(),
  }),
);

export const brewProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'brew',
      ttlSeconds: 1 * DAY,
      timeoutMs: 30_000,
      schema: BrewFormulae,
      request: () => ({ url: 'https://formulae.brew.sh/api/formula.json' }),
    },
    cache,
  );

/** Artifact Hub — proof that a chart / plugin / operator is actually published. */
export const ArtifactHubResponse = z.object({
  packages: z
    .array(z.object({ name: z.string(), repository: z.object({ name: z.string() }).partial() }))
    .default([]),
});

export const artifactHubProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'artifacthub',
      ttlSeconds: 1 * DAY,
      timeoutMs: 8_000,
      schema: ArtifactHubResponse,
      request: (key) => ({
        url: `https://artifacthub.io/api/v1/packages/search?ts_query_web=${encodeURIComponent(key)}&limit=20`,
        init: { headers: { accept: 'application/json' } },
      }),
    },
    cache,
  );

export type ProviderName =
  | 'scorecard'
  | 'depsdev'
  | 'osv'
  | 'brew'
  | 'artifacthub'
  | 'krew'
  | 'operatorhub';

export const PROVIDER_NAMES: ProviderName[] = [
  'scorecard',
  'depsdev',
  'osv',
  'brew',
  'artifacthub',
  'krew',
  'operatorhub',
];
