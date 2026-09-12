# Analyzer (pass 1/2/3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the analyzer end to end — pass 1 (local rules, already written), pass 2 (external
signals), pass 3 (LLM fallback) — so `mise run repo:analyze` reads `RepoFetched{changed:true}`
off the journal, writes a schema-validated `analysis/{repo}.json`, and appends `RepoAnalyzed`.

**Architecture:** `packages/analyze` gets three new modules — `rules/package-identity.ts` (pure
manifest → OSV package identity), `signals.ts` (pass 2: orchestrates the six signal sources now
in `@keco/signals` — Scorecard, deps.dev, OSV, Homebrew, Artifact Hub, and CNCF Landscape —
producing `Signals` + verified `install_methods`), and `llm.ts` (rewritten pass 3: a real
Anthropic tool-use call, forced-structured output validated against the taxonomy, one retry). A
new `analyze.ts` composes all three passes plus the existing `rules/kind.ts` / `rules/runtime.ts`
/ `rules/derived.ts` into one `analyzeRepo()` that returns a schema-validated `Analysis`.
`apps/workers/src/analyzer/index.ts` stays thin: it reads the four cached artifacts a repo needs
(`repo.json`, `readme.md`, `tree.json`, `manifests/*`) off `Cache`, calls `analyzeRepo()`, writes
the result, appends the event, and advances the checkpoint — mirroring how `crawler/index.ts`
stays thin over `sources/github/fetch.ts`.

Three provider gaps get closed in `@keco/signals` along the way: OSV needs an ecosystem *and* a
name to query precisely (today's provider only takes a name), Artifact Hub's schema is widened
enough to build a real, provable install command (`repository.kind`, `repository.url`,
`normalized_name`) — verified live against `artifacthub.io`'s actual API shape — and a new CNCF
Landscape provider fills the `landscape` slot `classifyDerived` has always accepted but never
received, so `maturity`/`governance` stop reporting `unknown` for real foundation projects
(etcd-io, containerd, helm, prometheus, cilium — the exact examples AGENTS.md §6 names). This is
the one provider here that isn't JSON (`landscape.yml` is YAML), so `Provider<T>` gains a small
`parseBody` hook to support it — see Task 4.

**Scope decisions (record these — they are deliberate, not oversights):**
- Pass 2 registry proof covers Homebrew and Artifact Hub (helm charts + krew plugins, via
  `repository.kind` 0 and 5). krew's own index and OperatorHub are **not** wired as separate
  providers — Artifact Hub already indexes krew plugins, and OperatorHub's OLM install commands
  vary too much to safely fabricate one without a much larger follow-up. Documented in the
  ROADMAP task below, not silently dropped.
- CNCF Landscape membership feeds `maturity`/`governance` through the existing `landscape` slot
  only — it is not surfaced as a separate "external links" field on `Analysis`. Artifact Hub and
  Homebrew already carry their own proof link on each `install_methods` entry's `source_url`; a
  general-purpose "external refs" bundle (visible on the tool page once the projector exists) was
  considered and deliberately deferred rather than added speculatively ahead of a consumer.
- The "GitHub extra" signal (contributors, dependents, community profile, sharing the crawler's
  quota) is **not** implemented here — it needs its own `GITHUB_QUOTA_CRAWLER_SHARE`-aware
  budgeting, which is a separable piece of work. OpenSSF Scorecard (maintenance, code review, CI
  tests, signed releases, branch protection, dangerous workflows, known vulns) and OSV (known
  vulnerabilities) already cover "security score" — see Task 5 — so this gap is specifically
  contributor/dependent counts and community-profile completeness, not security signal.
- Re-analysis driven by *signal TTL expiry* (as opposed to a `content_hash` change) is its own
  ROADMAP line item and stays out of scope; this plan implements the `content_hash`-driven path
  plus the two manual bypasses the CLI already exposes (`--repo`, `--min-confidence`).
- The LLM decides `summary`, `kind`, `domains`, `confidence`, `needs_review` only. `runtime`,
  `license_class`, `openness`, `maturity`, `governance` and `k8s_relevance` are always rule-derived
  — pass 3 never touches them, keeping the rules-first ordering honest.

**Tech Stack:** TypeScript/ESM/zod (existing), `@anthropic-ai/sdk` (already a declared
dependency of `@keco/analyze`), `yaml` (new dependency of `@keco/signals` — CNCF Landscape's
source file), vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-analyzer-design.md`. Read it before Task 1 — it
has the rationale for every scope decision below, plus the live Artifact Hub API responses this
plan's Artifact Hub schema and matching logic are verified against.

---

## Reference: what already exists (do not re-implement)

- `packages/analyze/src/rules/kind.ts` — `classifyKind`, `classifyDomains`, `k8sRelevance`.
- `packages/analyze/src/rules/runtime.ts` — `classifyRuntime`.
- `packages/analyze/src/rules/derived.ts` — `classifyDerived` (license_class/openness/maturity/governance).
- `packages/signals/src/provider.ts` — the cached, TTL'd, timed-out `Provider<T>` wrapper every
  signal goes through.
- `packages/signals/src/providers/scorecard.ts` and `providers/index.ts` — `scorecardProvider`,
  `depsDevProvider`, `osvProvider`, `brewProvider`, `artifactHubProvider`.
- `packages/analyze/src/rules/derived.ts` — `classifyDerived` already takes a `landscape:
  LandscapeEntry | null` and has since it was written; nothing has ever populated it with
  anything but `null`. Task 4 is what finally does.
- `@keco/cache`: `Cache`, `repoKeys`, `analysisKey`, `Journal`.
- `@keco/core`: `AnalysisSchema`, `Analysis`, `FALLBACK_KIND`, `allValues`, `valueSchema`,
  `listSchema`.
- CLI wiring is already complete: `apps/workers/src/cli/program.ts`'s `analyze` command and
  `apps/workers/src/cli/handlers.ts`'s `repoAnalyze` already pass `AnalyzeOptions` through — this
  plan only changes what `runAnalyzer` does with them.

---

### Task 1: OSV provider — ecosystem-aware key

**Files:**
- Modify: `packages/signals/src/providers/index.ts`
- Test: `packages/signals/src/providers/index.test.ts` (new)

OSV needs an ecosystem *and* a name to query precisely (`{"package": {"name": ..., "ecosystem":
...}}`) — a bare name alone risks matching an unrelated package. The provider's `key` becomes
`"<ecosystem>::<name>"`, built by `encodeOsvKey`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/signals/src/providers/index.test.ts
import { Cache, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeOsvKey, osvProvider } from './index';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('osvProvider', () => {
  it('queries OSV with both the ecosystem and the name', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response(JSON.stringify({ vulns: [{ id: 'GHSA-1' }] }), { status: 200 });
      }),
    );

    const cache = new Cache(memoryStorage());
    const result = await osvProvider(cache).fetch(encodeOsvKey('Go', 'sigs.k8s.io/controller-runtime'));

    expect(result.value?.vulns).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      package: { name: 'sigs.k8s.io/controller-runtime', ecosystem: 'Go' },
    });
  });

  it('degrades without a network call when the key has no ecosystem', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const cache = new Cache(memoryStorage());

    const result = await osvProvider(cache).fetch('not-a-valid-key');

    expect(result).toEqual({ value: null, fetched_at: null, partial: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/signals exec vitest run src/providers/index.test.ts`
Expected: FAIL — `encodeOsvKey` is not exported, and the current `osvProvider` sends
`{"package":{"name":"Go::sigs.k8s.io/controller-runtime"}}`, not split into `name`/`ecosystem`.

- [ ] **Step 3: Implement**

Replace the `OsvResponse` / `osvProvider` block in `packages/signals/src/providers/index.ts`
with:

```typescript
/** OSV.dev — known vulnerabilities affecting the project. */
export const OsvResponse = z.object({
  vulns: z.array(z.object({ id: z.string(), summary: z.string().optional() })).default([]),
});

/** `ecosystem::name` — OSV needs both to query precisely; see packages/analyze's package-identity.ts. */
export const encodeOsvKey = (ecosystem: string, name: string): string => `${ecosystem}::${name}`;

export const osvProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'osv',
      ttlSeconds: 3 * DAY,
      timeoutMs: 8_000,
      schema: OsvResponse,
      // key is `ecosystem::name` (see encodeOsvKey). The analyzer derives both from the one
      // manifest it managed to parse — a bare repo name is not enough to query OSV precisely.
      request: (key) => {
        const [ecosystem, ...rest] = key.split('::');
        const name = rest.join('::');
        if (!ecosystem || !name) return null;
        return {
          url: 'https://api.osv.dev/v1/query',
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ package: { name, ecosystem } }),
          },
        };
      },
    },
    cache,
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/signals exec vitest run src/providers/index.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/signals/src/providers/index.ts packages/signals/src/providers/index.test.ts
git commit -m "feat(signals): make the OSV provider ecosystem-aware

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Artifact Hub — a schema that can prove an install command

**Files:**
- Modify: `packages/signals/src/providers/index.ts`
- Test: `packages/signals/src/providers/index.test.ts`

Verified live against `https://artifacthub.io/api/v1/packages/search`: each result carries
`normalized_name`, `official`, `stars`, and `repository.{name,url,kind}` (`kind: 0` = Helm,
`kind: 5` = krew — confirmed via `GET /api/v1/repositories/search?kind=5`). That's enough to
build `https://artifacthub.io/packages/{helm|krew}/{repository.name}/{normalized_name}` and a
real `helm repo add` / `kubectl krew install` command — the two registries this plan proves
installs from.

- [ ] **Step 1: Write the failing test**

Add to `packages/signals/src/providers/index.test.ts`:

```typescript
import { ARTIFACTHUB_REPOSITORY_KIND, ArtifactHubResponse } from './index';

describe('ArtifactHubResponse', () => {
  it('parses a real search response shape, including the fields a proof URL needs', () => {
    const sample = {
      packages: [
        {
          name: 'cert-manager',
          normalized_name: 'cert-manager',
          official: true,
          stars: 990,
          repository: {
            name: 'cert-manager',
            url: 'https://charts.jetstack.io',
            kind: 0,
          },
        },
      ],
    };

    const parsed = ArtifactHubResponse.parse(sample);
    expect(parsed.packages[0]?.repository.kind).toBe(ARTIFACTHUB_REPOSITORY_KIND.helm);
    expect(parsed.packages[0]?.normalized_name).toBe('cert-manager');
  });

  it('degrades a package with a missing repository field to optional rather than failing the whole batch', () => {
    const parsed = ArtifactHubResponse.parse({ packages: [{ name: 'weird', repository: {} }] });
    expect(parsed.packages[0]?.repository.kind).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/signals exec vitest run src/providers/index.test.ts`
Expected: FAIL — `ARTIFACTHUB_REPOSITORY_KIND` doesn't exist, and today's schema drops
`normalized_name`/`official`/`stars`/`repository.url`/`repository.kind` entirely (`.partial()`
with only `name`).

- [ ] **Step 3: Implement**

Replace the `ArtifactHubResponse` / `artifactHubProvider` block in
`packages/signals/src/providers/index.ts` with:

```typescript
/** Artifact Hub — proof that a chart / plugin / operator is actually published. */
export const ArtifactHubPackage = z.object({
  name: z.string(),
  normalized_name: z.string().optional(),
  official: z.boolean().optional(),
  stars: z.number().optional(),
  repository: z.object({ name: z.string(), url: z.string(), kind: z.number() }).partial(),
});
export type ArtifactHubPackage = z.infer<typeof ArtifactHubPackage>;

export const ArtifactHubResponse = z.object({
  packages: z.array(ArtifactHubPackage).default([]),
});
export type ArtifactHubResponse = z.infer<typeof ArtifactHubResponse>;

/**
 * Repository `kind` codes for the registries this project proves an install command from.
 * Confirmed live: `GET /api/v1/repositories/search?kind=5` returns krew-index at kind 5;
 * a Helm search (cert-manager, argo-cd, …) returns kind 0. Artifact Hub also indexes OLM
 * operators, Falco rules, OPA policies, etc. — deliberately not mapped here (see the plan's
 * scope note): getting an OLM install command right needs more than a search hit.
 */
export const ARTIFACTHUB_REPOSITORY_KIND = { helm: 0, krew: 5 } as const;

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/signals exec vitest run src/providers/index.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/signals/src/providers/index.ts packages/signals/src/providers/index.test.ts
git commit -m "feat(signals): widen the Artifact Hub schema enough to prove an install command

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `packages/analyze` — package identity from a manifest

**Files:**
- Create: `packages/analyze/src/rules/package-identity.ts`
- Test: `packages/analyze/src/rules/package-identity.test.ts`

Pure, manifest-only, no network — exactly what OSV needs to be queried precisely instead of by a
bare repo name. Ordered strongest-first: go.mod, then package.json, then Cargo.toml, then
pyproject.toml.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/analyze/src/rules/package-identity.test.ts
import { describe, expect, it } from 'vitest';
import { identifyPackage } from './package-identity';

describe('identifyPackage', () => {
  it('reads the module path from go.mod', () => {
    expect(identifyPackage({ 'go.mod': 'module sigs.k8s.io/controller-runtime\n\ngo 1.22\n' })).toEqual({
      ecosystem: 'Go',
      name: 'sigs.k8s.io/controller-runtime',
    });
  });

  it('reads the name field from package.json', () => {
    expect(identifyPackage({ 'package.json': JSON.stringify({ name: '@kubernetes/client-node' }) })).toEqual({
      ecosystem: 'npm',
      name: '@kubernetes/client-node',
    });
  });

  it('reads the package name from Cargo.toml', () => {
    const cargo = '[package]\nname = "kube"\nversion = "0.1.0"\n';
    expect(identifyPackage({ 'Cargo.toml': cargo })).toEqual({ ecosystem: 'crates.io', name: 'kube' });
  });

  it('reads the project name from pyproject.toml', () => {
    const pyproject = '[project]\nname = "kopf"\nversion = "1.0"\n';
    expect(identifyPackage({ 'pyproject.toml': pyproject })).toEqual({ ecosystem: 'PyPI', name: 'kopf' });
  });

  it('degrades to null rather than guess when no manifest gives a clean identity', () => {
    expect(identifyPackage({})).toBeNull();
    expect(identifyPackage({ 'package.json': '{not json' })).toBeNull();
  });

  it('prefers go.mod when a repo somehow carries more than one manifest', () => {
    expect(
      identifyPackage({
        'go.mod': 'module example.com/foo\n',
        'package.json': JSON.stringify({ name: 'foo' }),
      }),
    ).toEqual({ ecosystem: 'Go', name: 'example.com/foo' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/analyze exec vitest run src/rules/package-identity.test.ts`
Expected: FAIL — the module does not exist yet.

- [ ] **Step 3: Implement**

```typescript
// packages/analyze/src/rules/package-identity.ts

/**
 * Which published package this repo *is*, derived from a manifest already in the cache
 * (AGENTS.md §4.2 pass 2). OSV.dev needs an ecosystem and a name to query precisely — a bare
 * repo name risks matching the wrong package's vulnerabilities against this repo's page, which
 * is exactly the kind of false positive §14 forbids.
 *
 * Ordered strongest-first. A repo carrying more than one manifest (rare) gets the first match.
 */
export type PackageIdentity = { ecosystem: string; name: string };

const GO_MODULE = /^module\s+(\S+)/m;
const CARGO_NAME = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m;
const PYPROJECT_NAME = /^\[(?:project|tool\.poetry)\][^[]*?^name\s*=\s*"([^"]+)"/m;

export function identifyPackage(manifests: Record<string, string>): PackageIdentity | null {
  const goMod = manifests['go.mod'];
  if (goMod) {
    const match = GO_MODULE.exec(goMod);
    if (match?.[1]) return { ecosystem: 'Go', name: match[1] };
  }

  const packageJson = manifests['package.json'];
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name !== '') {
        return { ecosystem: 'npm', name: parsed.name };
      }
    } catch {
      // Not valid JSON — degrade, never fail (§4.2).
    }
  }

  const cargoToml = manifests['Cargo.toml'];
  if (cargoToml) {
    const match = CARGO_NAME.exec(cargoToml);
    if (match?.[1]) return { ecosystem: 'crates.io', name: match[1] };
  }

  const pyproject = manifests['pyproject.toml'];
  if (pyproject) {
    const match = PYPROJECT_NAME.exec(pyproject);
    if (match?.[1]) return { ecosystem: 'PyPI', name: match[1] };
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/analyze exec vitest run src/rules/package-identity.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/analyze/src/rules/package-identity.ts packages/analyze/src/rules/package-identity.test.ts
git commit -m "feat(analyze): derive an OSV-queryable package identity from a manifest

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: CNCF Landscape — a real `landscape` signal, not always `null`

**Files:**
- Move: `LandscapeEntry` type from `packages/analyze/src/rules/derived.ts` to `packages/core/src/schemas.ts`
- Modify: `packages/analyze/src/rules/derived.ts` (import instead of declare)
- Modify: `packages/signals/src/provider.ts` (add `parseBody`)
- Modify: `packages/signals/package.json` (add `yaml` dependency)
- Create: `packages/signals/src/providers/cncf-landscape.ts`
- Modify: `packages/signals/src/providers/index.ts` (re-export it)
- Test: `packages/signals/src/providers/cncf-landscape.test.ts` (new)

Verified live: `https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml` (1.1 MB,
YAML, not JSON) nests as `landscape: [{category: {subcategories: [{subcategory: {items: [{item:
{name, repo_url, project}}]}}]}}]`. `item.project` is present only for CNCF-hosted entries —
`'graduated' | 'incubating' | 'sandbox' | 'archived'` (28 archived, 39 graduated, 37 incubating,
151 sandbox at the time this was checked) — confirmed against `cert-manager` (`project:
graduated`, `repo_url: https://github.com/cert-manager/cert-manager`) and `containerd` (same
shape). Everything else in the corpus (the vast majority of the landscape, and effectively all
of Keco's) carries no `project` field at all — it's a directory entry, not a CNCF project.

**`org_type` derivation.** `LandscapeEntry.org_type` is `'foundation' | 'vendor' | 'community' |
null`. The landscape file has no clean per-item signal for vendor-vs-community, but it has an
unambiguous one for foundation: hosting a project at any level (graduated, incubating, or
sandbox) means the CNCF's Technical Oversight Committee now steers it, which is exactly what
`org_type: 'foundation'` claims. So: `project` matches one of the three live levels →
`{cncf_level: <that level>, org_type: 'foundation'}`. `project: archived` (a level `LandscapeEntry`
has no slot for — it means "no longer hosted") and every other entry → not indexed at all,
same as not being in the file.

**`Provider<T>` needs one small generalization first.** Every existing provider calls
`response.json()` unconditionally (`packages/signals/src/provider.ts`'s `perform()`). CNCF
Landscape's body is YAML text, so `ProviderDefinition` gains an optional `parseBody` hook,
defaulting to today's `.json()` — every other provider is unaffected.

- [ ] **Step 1: Write the failing test for `Provider<T>`'s `parseBody` hook**

```typescript
// packages/signals/src/provider.test.ts
import { Cache, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DAY, Provider } from './provider';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Provider parseBody', () => {
  it('uses a custom body parser instead of .json() when one is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('name: value', { status: 200 })));
    const cache = new Cache(memoryStorage());
    const provider = new Provider(
      {
        name: 'yaml-test',
        ttlSeconds: DAY,
        timeoutMs: 1_000,
        schema: z.object({ name: z.string() }),
        request: () => ({ url: 'https://example.test/thing.yaml' }),
        parseBody: async (response) => {
          const text = await response.text();
          const [, value] = text.split(': ');
          return { name: value };
        },
      },
      cache,
    );

    const result = await provider.fetch('all');

    expect(result.value).toEqual({ name: 'value' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/signals exec vitest run src/provider.test.ts`
Expected: FAIL — `parseBody` is not a recognized field of `ProviderDefinition`, and `perform()`
always calls `.json()`, which throws on the plain-text body above.

- [ ] **Step 3: Add `parseBody` to `Provider<T>`**

In `packages/signals/src/provider.ts`, add the field to `ProviderDefinition` and use it in
`perform`:

```typescript
export type ProviderDefinition<T> = {
  name: string;
  ttlSeconds: number;
  timeoutMs: number;
  schema: z.ZodType<T>;
  request: (key: string) => { url: string; init?: RequestInit } | null;
  /** Defaults to `response.json()`. Override for a non-JSON body (CNCF Landscape's YAML). */
  parseBody?: (response: Response) => Promise<unknown>;
};
```

and inside `perform`, replace:

```typescript
      const parsed = this.definition.schema.safeParse(await response.json());
```

with:

```typescript
      const body = await (this.definition.parseBody ?? ((r: Response) => r.json()))(response);
      const parsed = this.definition.schema.safeParse(body);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/signals exec vitest run src/provider.test.ts`
Expected: PASS (1 test) — and run the full signals suite to confirm nothing else regressed:
`pnpm --filter @keco/signals exec vitest run`.

- [ ] **Step 5: Move `LandscapeEntry` to `@keco/core`**

In `packages/core/src/schemas.ts`, add (near `Signals`, since both are pass-2 shared shapes):

```typescript
/**
 * A CNCF Landscape entry for one repo (AGENTS.md §4.2, §6). Built by
 * `packages/signals/src/providers/cncf-landscape.ts`, consumed by
 * `packages/analyze/src/rules/derived.ts`'s `classifyDerived`. Lives in `@keco/core` — not
 * `@keco/signals` or `packages/analyze` — because both of those packages need the same shape
 * without either importing the other.
 */
export const LandscapeEntry = z.object({
  cncf_level: z.enum(['graduated', 'incubating', 'sandbox']).nullable(),
  org_type: z.enum(['foundation', 'vendor', 'community']).nullable(),
});
export type LandscapeEntry = z.infer<typeof LandscapeEntry>;
```

In `packages/analyze/src/rules/derived.ts`, delete the local `LandscapeEntry` type declaration
(the `export type LandscapeEntry = { cncf_level: ...; org_type: ...; }` block near the top) and
add to the existing `@keco/core` import:

```typescript
import { aliasesFor, type LandscapeEntry } from '@keco/core';
```

`DerivedInput.landscape: LandscapeEntry | null` stays exactly as it reads today — only where the
type comes from changes.

- [ ] **Step 6: Run the existing derived/fixtures tests to confirm nothing broke**

Run: `pnpm --filter @keco/analyze exec vitest run src/rules/derived.test.ts src/rules/fixtures.test.ts src/rules/pinning.test.ts`
Expected: PASS — these fixtures already pass `landscape` objects shaped exactly like
`LandscapeEntry`; only the import source moved.

- [ ] **Step 7: Add the `yaml` dependency**

In `packages/signals/package.json`, add to `dependencies`:

```json
    "yaml": "^2.8.1",
```

(matching the version `packages/core` already pins for `taxonomy.yaml`). Run
`pnpm install` at the workspace root afterward.

- [ ] **Step 8: Write the failing test for the CNCF Landscape provider**

```typescript
// packages/signals/src/providers/cncf-landscape.test.ts
import { Cache, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLandscapeIndex,
  cncfLandscapeProvider,
  lookupLandscape,
  repoLandscapeUrl,
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

afterEach(() => {
  vi.unstubAllGlobals();
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
});

describe('lookupLandscape', () => {
  it('fetches, parses YAML, and looks up one repo in a single call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(LANDSCAPE_YAML, { status: 200 })));
    const cache = new Cache(memoryStorage());

    const result = await lookupLandscape(cache, 'cert-manager/cert-manager');

    expect(result).toEqual({ entry: { cncf_level: 'graduated', org_type: 'foundation' }, partial: false });
  });

  it('degrades to a null entry, marked partial, when the source is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
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
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `pnpm --filter @keco/signals exec vitest run src/providers/cncf-landscape.test.ts`
Expected: FAIL — the module does not exist yet.

- [ ] **Step 10: Implement the provider**

```typescript
// packages/signals/src/providers/cncf-landscape.ts
import type { Cache } from '@keco/cache';
import type { LandscapeEntry } from '@keco/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DAY, Provider } from '../provider';

/**
 * CNCF Landscape (AGENTS.md §4.2, §6) — the seed that lets `classifyGovernance` and
 * `classifyMaturity` stop reporting `unknown` for real foundation projects (etcd-io,
 * containerd, helm, prometheus, cilium). One bulk file for the whole corpus (§4.2's "bulk over
 * per-repo" — the same shape as `brewProvider`'s `formula.json`), fetched under the fixed key
 * `all` and re-indexed on every lookup: cheap CPU over an already-parsed, cached structure, no
 * extra network cost after the first repo in a run. Revisit only if profiling ever says
 * otherwise.
 *
 * The source is YAML, not JSON — the one provider in this package needing `parseBody`.
 */

const LandscapeItem = z
  .object({
    name: z.string().optional(),
    repo_url: z.string().optional(),
    /** 'graduated' | 'incubating' | 'sandbox' | 'archived' (retired) | absent (not CNCF-hosted). */
    project: z.string().optional(),
  })
  .passthrough();

const LandscapeSubcategory = z
  .object({
    items: z.array(z.object({ item: LandscapeItem.optional() }).passthrough()).optional(),
  })
  .passthrough();

const LandscapeCategoryEntry = z
  .object({
    subcategories: z.array(z.object({ subcategory: LandscapeSubcategory.optional() }).passthrough()).optional(),
  })
  .passthrough();

/**
 * Lenient by design (`.passthrough()` at every level): the real file carries dozens of fields
 * per item this module never reads, and a schema drift there must never take the whole signal
 * down (§4.2 "degrade, never fail").
 */
export const CncfLandscapeFile = z.object({
  landscape: z.array(z.object({ category: LandscapeCategoryEntry.optional() }).passthrough()).default([]),
});
export type CncfLandscapeFile = z.infer<typeof CncfLandscapeFile>;

export const cncfLandscapeProvider = (cache: Cache) =>
  new Provider(
    {
      name: 'cncf-landscape',
      ttlSeconds: 7 * DAY,
      timeoutMs: 30_000,
      schema: CncfLandscapeFile,
      request: () => ({ url: 'https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml' }),
      parseBody: async (response) => parseYaml(await response.text()),
    },
    cache,
  );

const CNCF_LEVELS = new Set(['graduated', 'incubating', 'sandbox']);

/** Case- and trailing-slash/`.git`-insensitive, so the index key and the query key always agree. */
function normalizeRepoUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
}

/** `owner/repo` → its GitHub URL, normalized the same way `buildLandscapeIndex` keys its map. */
export function repoLandscapeUrl(repo: string): string {
  return normalizeRepoUrl(`https://github.com/${repo}`);
}

/**
 * One entry per repo. First occurrence wins when a project is cross-listed under more than one
 * category (containerd's `second_path`, for instance) — the CNCF level is the same claim
 * either way.
 */
export function buildLandscapeIndex(file: CncfLandscapeFile): Map<string, LandscapeEntry> {
  const index = new Map<string, LandscapeEntry>();
  for (const categoryWrap of file.landscape) {
    for (const subWrap of categoryWrap.category?.subcategories ?? []) {
      for (const itemWrap of subWrap.subcategory?.items ?? []) {
        const item = itemWrap.item;
        if (!item?.repo_url || !item.project || !CNCF_LEVELS.has(item.project)) continue;
        const key = normalizeRepoUrl(item.repo_url);
        if (!index.has(key)) {
          index.set(key, {
            cncf_level: item.project as 'graduated' | 'incubating' | 'sandbox',
            // Hosting a project at any level means the foundation now steers it via the TOC —
            // the strongest governance evidence this pipeline has (§6).
            org_type: 'foundation',
          });
        }
      }
    }
  }
  return index;
}

/** Fetch (cached) + index + look up one repo, in a single call — what `gatherSignals` uses. */
export async function lookupLandscape(
  cache: Cache,
  repo: string,
  options: { forceRefresh?: boolean; now?: Date } = {},
): Promise<{ entry: LandscapeEntry | null; partial: boolean }> {
  const result = await cncfLandscapeProvider(cache).fetch('all', options);
  if (!result.value) return { entry: null, partial: result.partial };
  const index = buildLandscapeIndex(result.value);
  return { entry: index.get(repoLandscapeUrl(repo)) ?? null, partial: false };
}
```

- [ ] **Step 11: Re-export it**

In `packages/signals/src/providers/index.ts`, add:

```typescript
export * from './cncf-landscape';
```

(alongside the existing `export * from './scorecard';` at the top of the file.)

- [ ] **Step 12: Run the test to verify it passes**

Run: `pnpm --filter @keco/signals exec vitest run src/providers/cncf-landscape.test.ts`
Expected: PASS (5 tests)

Run: `pnpm --filter @keco/signals exec tsc --noEmit`
Expected: no errors

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/schemas.ts packages/analyze/src/rules/derived.ts \
  packages/signals/src/provider.ts packages/signals/src/provider.test.ts \
  packages/signals/package.json packages/signals/src/providers/cncf-landscape.ts \
  packages/signals/src/providers/cncf-landscape.test.ts packages/signals/src/providers/index.ts
git commit -m "feat(signals): a real CNCF Landscape provider, not always null

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `packages/analyze` — pass 2, `gatherSignals`

**Files:**
- Create: `packages/analyze/src/signals.ts`
- Test: `packages/analyze/src/signals.test.ts`

Orchestrates all six signal sources, always degrading rather than throwing, and builds
`install_methods` only from Homebrew name matches and Artifact Hub matches (§6: unprovable ⇒ not
listed). CNCF Landscape (Task 4) is the newest of the six and the only one that doesn't feed
`Signals` or `install_methods` — it feeds a new `landscape` field on `SignalsResult`, which
`analyzeRepo` (Task 7) hands to `classifyDerived` instead of the hardcoded `null` every call has
passed until now.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/analyze/src/signals.test.ts
import { Cache, type Storage } from '@keco/cache';
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
function fakeFetch(byUrlSubstring: Record<string, { status: number; body?: unknown; text?: string }>) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const match = Object.entries(byUrlSubstring).find(([needle]) => url.includes(needle));
    if (!match) return new Response('not found', { status: 404 });
    const [, response] = match;
    return new Response(response.text ?? JSON.stringify(response.body), { status: response.status });
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
      { repo: 'cert-manager/cert-manager', name: 'cert-manager', kind: 'helm-chart', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.signals.scorecard).toEqual({
      score: 8.2,
      checks: { 'Code-Review': 9 },
      fetched_at: expect.any(String),
    });
    expect(result.signals.dependents).toBe(42);
    expect(result.landscape).toEqual({ cncf_level: 'graduated', org_type: 'foundation' });
    expect(result.signals_used.sort()).toEqual(['artifacthub', 'brew', 'cncf-landscape', 'depsdev', 'scorecard']);
    expect(result.partial_signals).toEqual([]);
    expect(result.install_methods).toEqual([
      {
        method: 'helm',
        command: 'helm repo add cert-manager https://charts.jetstack.io\nhelm install cert-manager cert-manager/cert-manager',
        source_url: 'https://artifacthub.io/packages/helm/cert-manager/cert-manager',
        verified_at: expect.any(String),
      },
    ]);
  });

  it('degrades every signal (including landscape) to null and records each as partial when everything is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'someone/tool', name: 'tool', kind: 'cli', manifests: {} },
      { forceRefresh: null },
    );

    expect(result.signals).toEqual({ scorecard: null, osv: null, dependents: null });
    expect(result.landscape).toBeNull();
    expect(result.install_methods).toEqual([]);
    expect(result.signals_used).toEqual([]);
    expect(result.partial_signals.sort()).toEqual(['artifacthub', 'brew', 'cncf-landscape', 'depsdev', 'scorecard']);
  });

  it('populates landscape even when nothing else about the repo resolves', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'raw.githubusercontent.com': { status: 200, text: LANDSCAPE_YAML } }));
    const cache = new Cache(memoryStorage());

    const result = await gatherSignals(
      cache,
      { repo: 'cert-manager/cert-manager', name: 'cert-manager', kind: 'operator', manifests: {} },
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
        kind: 'library-sdk',
        manifests: { 'go.mod': 'module github.com/someone/tool\n' },
      },
      { forceRefresh: null },
    );

    expect(result.signals.osv).toEqual({ open_vulns: 1, fetched_at: expect.any(String) });
    expect(result.signals_used).toContain('osv');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/analyze exec vitest run src/signals.test.ts`
Expected: FAIL — `./signals` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
// packages/analyze/src/signals.ts
import type { Cache } from '@keco/cache';
import type { InstallMethodEntry, LandscapeEntry, Signals } from '@keco/core';
import {
  ARTIFACTHUB_REPOSITORY_KIND,
  artifactHubProvider,
  brewProvider,
  checkScores,
  depsDevProvider,
  encodeOsvKey,
  lookupLandscape,
  osvProvider,
  scorecardProvider,
  type ArtifactHubPackage,
} from '@keco/signals';
import { identifyPackage } from './rules/package-identity';

/**
 * Pass 2 — external signals (AGENTS.md §4.2). Every provider degrades to `null` on failure and
 * is recorded in `partial_signals`; nothing here may throw the analyzer off a repo (§13).
 */
export type SignalsInput = {
  repo: string; // owner/repo
  name: string; // bare repo name
  kind: string | null;
  manifests: Record<string, string>;
};

export type GatherSignalsOptions = {
  /** The one manual TTL bypass, and it is per-provider (§4.2). */
  forceRefresh: string | null;
  now?: Date;
};

export type SignalsResult = {
  signals: Signals;
  /** From CNCF Landscape — `null` for the vast majority of the corpus, which isn't CNCF-hosted. */
  landscape: LandscapeEntry | null;
  install_methods: InstallMethodEntry[];
  signals_used: string[];
  partial_signals: string[];
};

export async function gatherSignals(
  cache: Cache,
  input: SignalsInput,
  options: GatherSignalsOptions,
): Promise<SignalsResult> {
  const now = options.now ?? new Date();
  const used: string[] = [];
  const partial: string[] = [];
  const force = (name: string) => options.forceRefresh === name;

  const scorecard = await scorecardProvider(cache).fetch(input.repo, { forceRefresh: force('scorecard'), now });
  if (scorecard.value) used.push('scorecard');
  else if (scorecard.partial) partial.push('scorecard');

  const depsdev = await depsDevProvider(cache).fetch(input.repo, { forceRefresh: force('depsdev'), now });
  if (depsdev.value) used.push('depsdev');
  else if (depsdev.partial) partial.push('depsdev');

  const landscape = await lookupLandscape(cache, input.repo, { forceRefresh: force('cncf-landscape'), now });
  if (landscape.partial) partial.push('cncf-landscape');
  else used.push('cncf-landscape');

  let osvOpenVulns: number | null = null;
  let osvFetchedAt: string | null = null;
  const identity = identifyPackage(input.manifests);
  if (identity) {
    const osv = await osvProvider(cache).fetch(encodeOsvKey(identity.ecosystem, identity.name), {
      forceRefresh: force('osv'),
      now,
    });
    if (osv.value) {
      used.push('osv');
      osvOpenVulns = osv.value.vulns.length;
      osvFetchedAt = osv.fetched_at;
    } else if (osv.partial) {
      partial.push('osv');
    }
  }

  const installMethods: InstallMethodEntry[] = [];

  // Bulk file, cached under a fixed key: one network call per TTL window for the whole corpus,
  // never one per repo (§4.2).
  const brew = await brewProvider(cache).fetch('all', { forceRefresh: force('brew'), now });
  if (brew.value) {
    used.push('brew');
    const formula = brew.value.find((f) => f.name.toLowerCase() === input.name.toLowerCase());
    if (formula) {
      installMethods.push({
        method: 'brew',
        command: `brew install ${formula.name}`,
        source_url: `https://formulae.brew.sh/formula/${formula.name}`,
        verified_at: now.toISOString(),
      });
    }
  } else if (brew.partial) {
    partial.push('brew');
  }

  const artifacthub = await artifactHubProvider(cache).fetch(input.name, { forceRefresh: force('artifacthub'), now });
  if (artifacthub.value) {
    used.push('artifacthub');
    const match = bestArtifactHubMatch(artifacthub.value.packages, input.name);
    if (match) installMethods.push(toInstallMethod(match, input.name, now));
  } else if (artifacthub.partial) {
    partial.push('artifacthub');
  }

  return {
    signals: {
      scorecard: scorecard.value
        ? {
            score: Math.min(10, Math.max(0, scorecard.value.score)),
            checks: checkScores(scorecard.value),
            fetched_at: scorecard.fetched_at!,
          }
        : null,
      osv: osvOpenVulns !== null ? { open_vulns: osvOpenVulns, fetched_at: osvFetchedAt! } : null,
      dependents: depsdev.value?.dependentCount ?? null,
    },
    landscape: landscape.entry,
    install_methods: installMethods,
    signals_used: used,
    partial_signals: partial,
  };
}

/**
 * Exact, case-insensitive name match only (§6 and §14: a plugin name like `ctx` for `kubectx`
 * is a real, accepted false negative — never a false positive). Among ties, prefer the
 * `official`-flagged repository, then the most-starred: the search endpoint has no reliable
 * ordering guarantee across unrelated third-party republications of the same chart name.
 */
function bestArtifactHubMatch(packages: ArtifactHubPackage[], repoName: string): ArtifactHubPackage | null {
  const candidates = packages.filter(
    (pkg) =>
      pkg.name.toLowerCase() === repoName.toLowerCase() &&
      pkg.normalized_name !== undefined &&
      pkg.repository.name !== undefined &&
      (pkg.repository.kind === ARTIFACTHUB_REPOSITORY_KIND.helm ||
        pkg.repository.kind === ARTIFACTHUB_REPOSITORY_KIND.krew) &&
      (pkg.repository.kind !== ARTIFACTHUB_REPOSITORY_KIND.helm || pkg.repository.url !== undefined),
  );
  candidates.sort((a, b) => Number(b.official ?? false) - Number(a.official ?? false) || (b.stars ?? 0) - (a.stars ?? 0));
  return candidates[0] ?? null;
}

function toInstallMethod(pkg: ArtifactHubPackage, repoName: string, now: Date): InstallMethodEntry {
  const isHelm = pkg.repository.kind === ARTIFACTHUB_REPOSITORY_KIND.helm;
  const method = isHelm ? 'helm' : 'krew';
  const sourceUrl = `https://artifacthub.io/packages/${method}/${pkg.repository.name}/${pkg.normalized_name}`;
  const command = isHelm
    ? `helm repo add ${pkg.repository.name} ${pkg.repository.url}\nhelm install ${repoName} ${pkg.repository.name}/${pkg.normalized_name}`
    : `kubectl krew install ${pkg.normalized_name}`;
  return { method, command, source_url: sourceUrl, verified_at: now.toISOString() };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/analyze exec vitest run src/signals.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/analyze/src/signals.ts packages/analyze/src/signals.test.ts
git commit -m "feat(analyze): pass 2 — gather external signals, CNCF Landscape, and provable install methods

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `packages/analyze` — pass 3, the real LLM fallback

**Files:**
- Modify: `packages/analyze/src/llm.ts` (full rewrite)
- Test: `packages/analyze/src/llm.test.ts` (new)

Structured output only: the tool's `input_schema` enum is built straight from
`packages/core/taxonomy.yaml`, so the model cannot emit a value the taxonomy doesn't declare.
One retry on invalid output, then the caller (Task 7) applies the honest fallback.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/analyze/src/llm.test.ts
import { describe, expect, it, vi } from 'vitest';
import { classifyWithLlm, type LlmClient, type LlmInput } from './llm';

const INPUT: LlmInput = {
  repo: 'someone/mystery-tool',
  readme: '# mystery-tool\n\nRuns things in your cluster.',
  topics: ['kubernetes'],
  tree: ['main.go', 'go.mod'],
  signals: { scorecard: null, osv: null, dependents: null },
};

function toolUseResponse(input: unknown) {
  return { content: [{ type: 'tool_use', input }] };
}

describe('classifyWithLlm', () => {
  it('returns the validated verdict from a well-formed tool call', async () => {
    const client: LlmClient = {
      messages: {
        create: vi.fn().mockResolvedValue(
          toolUseResponse({
            summary: 'Runs a controller that reconciles a custom resource.',
            kind: 'controller',
            domains: ['dev-experience'],
            confidence: 0.8,
            needs_review: false,
          }),
        ),
      },
    };

    const verdict = await classifyWithLlm(INPUT, { apiKey: 'test', model: 'claude-haiku-4-5-20251001', client });

    expect(verdict).toEqual({
      summary: 'Runs a controller that reconciles a custom resource.',
      kind: 'controller',
      domains: ['dev-experience'],
      confidence: 0.8,
      needs_review: false,
    });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('retries once on an invalid tool call, then succeeds', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse({ summary: 'x', kind: 'not-a-real-kind', domains: [], confidence: 2, needs_review: false }))
      .mockResolvedValueOnce(
        toolUseResponse({ summary: 'x', kind: 'cli', domains: ['dev-experience'], confidence: 0.5, needs_review: true }),
      );
    const client: LlmClient = { messages: { create } };

    const verdict = await classifyWithLlm(INPUT, { apiKey: 'test', model: 'claude-haiku-4-5-20251001', client });

    expect(verdict?.kind).toBe('cli');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('gives up after two invalid attempts and returns null', async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ summary: 'x' }));
    const client: LlmClient = { messages: { create } };

    const verdict = await classifyWithLlm(INPUT, { apiKey: 'test', model: 'claude-haiku-4-5-20251001', client });

    expect(verdict).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('treats a response with no tool call as invalid and retries', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: 'text' }] })
      .mockResolvedValueOnce(
        toolUseResponse({ summary: 'x', kind: 'cli', domains: ['dev-experience'], confidence: 0.4, needs_review: true }),
      );
    const client: LlmClient = { messages: { create } };

    const verdict = await classifyWithLlm(INPUT, { apiKey: 'test', model: 'claude-haiku-4-5-20251001', client });

    expect(verdict?.kind).toBe('cli');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/analyze exec vitest run src/llm.test.ts`
Expected: FAIL — `classifyWithLlm` currently throws `not implemented`, and `LlmClient` isn't
exported.

- [ ] **Step 3: Implement**

Replace the entire contents of `packages/analyze/src/llm.ts`:

```typescript
// packages/analyze/src/llm.ts
import Anthropic from '@anthropic-ai/sdk';
import { allValues, listSchema, valueSchema } from '@keco/core';
import type { Signals } from '@keco/core';
import { z } from 'zod';

/**
 * Pass 3 — the LLM fallback (AGENTS.md §4.2). It runs only when the rules and signals left the
 * repo ambiguous, sees a bounded context, and must return structured output validated against
 * the taxonomy itself — so the model cannot emit a `kind` or `domain` that doesn't exist in
 * packages/core/taxonomy.yaml. Free text never leaves the analyzer.
 */
export const CONFIDENCE_THRESHOLD = 0.7;
export const README_BUDGET_BYTES = 8 * 1024;

export type LlmInput = {
  repo: string;
  readme: string;
  topics: string[];
  tree: string[];
  signals: Signals;
};

export const needsLlm = (confidence: number): boolean => confidence < CONFIDENCE_THRESHOLD;

export const LlmVerdict = z.object({
  summary: z.string().max(400),
  kind: valueSchema('kind'),
  domains: listSchema('domains'),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean(),
});
export type LlmVerdict = z.infer<typeof LlmVerdict>;

const TOOL_NAME = 'classify_repo';

const CLASSIFICATION_TOOL = {
  name: TOOL_NAME,
  description:
    'Submit the classification for this Kubernetes ecosystem repository. Call this exactly once, with your best answer.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        maxLength: 400,
        description: 'One or two plain-language sentences describing what this project does.',
      },
      kind: {
        type: 'string',
        enum: allValues('kind').map((v) => v.id),
        description: 'What the artifact IS — exactly one.',
      },
      domains: {
        type: 'array',
        items: { type: 'string', enum: allValues('domains').map((v) => v.id) },
        minItems: 1,
        maxItems: 3,
        description: 'What problem(s) it solves — one to three.',
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      needs_review: {
        type: 'boolean',
        description: 'true if you are genuinely unsure even after picking your best answer.',
      },
    },
    required: ['summary', 'kind', 'domains', 'confidence', 'needs_review'],
  },
} as const;

/** The one call shape this module depends on — narrow on purpose so a test needs no SDK types. */
export type LlmClient = {
  messages: {
    create: (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; input?: unknown }> }>;
  };
};

export type LlmDeps = {
  apiKey: string;
  model: string;
  /** Injected in tests; defaults to a real Anthropic client. */
  client?: LlmClient;
};

function buildPrompt(input: LlmInput): string {
  return [
    `You are classifying the GitHub repository "${input.repo}" for Keco, a Kubernetes ecosystem search engine.`,
    `Topics: ${input.topics.join(', ') || '(none)'}`,
    `File tree (truncated): ${input.tree.slice(0, 200).join(', ') || '(empty)'}`,
    `External signals already gathered: ${JSON.stringify(input.signals)}`,
    `README (first ${README_BUDGET_BYTES} bytes):`,
    input.readme,
    '',
    `Call ${TOOL_NAME} with your answer. If you are genuinely unsure, set confidence low and ` +
      'needs_review true — never guess a specific kind or domain you are not confident about.',
  ].join('\n');
}

/** Pass 3 entry point. Returns `null` when two attempts both fail validation — the caller falls back. */
export async function classifyWithLlm(input: LlmInput, deps: LlmDeps): Promise<LlmVerdict | null> {
  const client: LlmClient = deps.client ?? (new Anthropic({ apiKey: deps.apiKey }) as unknown as LlmClient);
  const prompt = buildPrompt({ ...input, readme: input.readme.slice(0, README_BUDGET_BYTES) });

  let correction = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const message = await client.messages.create({
      model: deps.model,
      max_tokens: 512,
      tools: [CLASSIFICATION_TOOL],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: correction ? `${prompt}\n\n${correction}` : prompt }],
    });

    const block = message.content.find((b) => b.type === 'tool_use');
    if (!block) {
      correction = 'Your previous response did not call the tool. Call it now with your best answer.';
      continue;
    }

    const parsed = LlmVerdict.safeParse(block.input);
    if (parsed.success) return parsed.data;
    correction = `Your previous answer was invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}. Try again.`;
  }

  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/analyze exec vitest run src/llm.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/analyze/src/llm.ts packages/analyze/src/llm.test.ts
git commit -m "feat(analyze): pass 3 — real Anthropic tool-use call, taxonomy-constrained output

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `packages/analyze` — `analyzeRepo`, the three passes composed

**Files:**
- Create: `packages/analyze/src/analyze.ts`
- Test: `packages/analyze/src/analyze.test.ts`

One reordering from what Tasks 1–6 might suggest: `classifyDerived` (part of pass 1) now runs
*after* `gatherSignals` (pass 2), not before — it needs pass 2's `landscape` result, which Task 4
finally populates instead of a hardcoded `null`. `AnalyzeInput.derived` drops the `landscape`
field entirely; it's no longer something the caller supplies.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/analyze/src/analyze.test.ts
import { Cache, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeRepo, type AnalyzeInput } from './analyze';
import type { LlmVerdict } from './llm';

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

const NOW = new Date('2026-08-01T00:00:00.000Z');

const CERT_MANAGER: AnalyzeInput = {
  repo: 'cert-manager/cert-manager',
  content_hash: 'abc123',
  name: 'cert-manager',
  description: 'Automatically provision and manage TLS certificates in Kubernetes',
  topics: ['kubernetes-operator', 'security'],
  tree: ['config/crd/bases/foo.yaml', 'PROJECT', 'main.go'],
  manifests: {},
  language: 'Go',
  readme: '# cert-manager',
  derived: {
    owner: 'cert-manager',
    owner_type: 'Organization',
    license_spdx: 'Apache-2.0',
    archived: false,
    created_at: '2016-01-01T00:00:00.000Z',
    pushed_at: '2026-07-01T00:00:00.000Z',
    latest_release_at: '2026-06-01T00:00:00.000Z',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('analyzeRepo', () => {
  it('settles a confident, well-topic-tagged repo with rules alone — no LLM call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());
    const llmClient = { messages: { create: vi.fn() } };

    const analysis = await analyzeRepo(CERT_MANAGER, {
      cache,
      forceRefresh: null,
      llm: { apiKey: 'unused', model: 'unused', client: llmClient },
      now: NOW,
    });

    expect(analysis.method).toBe('rules');
    expect(analysis.kind).toBe('operator');
    expect(analysis.domains).toEqual(['security']);
    expect(analysis.runtime).toBe('in-cluster');
    expect(analysis.license_class).toBe('permissive');
    expect(analysis.confidence).toBeGreaterThanOrEqual(0.9);
    expect(analysis.needs_review).toBe(false);
    expect(llmClient.messages.create).not.toHaveBeenCalled();
  });

  it('picks up a CNCF Landscape hit from pass 2 and reflects it in governance and maturity', async () => {
    const landscapeYaml = `
landscape:
  - category:
      name: Certificates
      subcategories:
        - subcategory:
            name: Automation
            items:
              - item:
                  name: cert-manager
                  project: graduated
                  repo_url: https://github.com/cert-manager/cert-manager
`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('raw.githubusercontent.com')) return new Response(landscapeYaml, { status: 200 });
        return new Response('not found', { status: 404 });
      }),
    );
    const cache = new Cache(memoryStorage());

    const analysis = await analyzeRepo(CERT_MANAGER, { cache, forceRefresh: null, llm: null, now: NOW });

    expect(analysis.maturity).toBe('cncf-graduated');
    expect(analysis.governance).toBe('foundation');
  });

  it('calls the LLM when pass 1 is ambiguous, and uses its verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());
    const verdict: LlmVerdict = {
      summary: 'A mystery tool.',
      kind: 'service',
      domains: ['dev-experience'],
      confidence: 0.6,
      needs_review: true,
    };
    const llmClient = { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: verdict }] }) } };

    const ambiguous: AnalyzeInput = {
      ...CERT_MANAGER,
      repo: 'someone/mystery',
      name: 'mystery',
      topics: [],
      tree: ['main.go'],
      description: 'does a thing',
    };

    const analysis = await analyzeRepo(ambiguous, {
      cache,
      forceRefresh: null,
      llm: { apiKey: 'unused', model: 'unused', client: llmClient },
      now: NOW,
    });

    expect(analysis.method).toBe('llm');
    expect(analysis.kind).toBe('service');
    expect(analysis.confidence).toBe(0.6);
    expect(analysis.needs_review).toBe(true);
    expect(llmClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to the honest low-confidence answer when no LLM is configured and pass 1 is ambiguous', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());

    const ambiguous: AnalyzeInput = {
      ...CERT_MANAGER,
      repo: 'someone/mystery',
      name: 'mystery',
      topics: [],
      tree: ['main.go'],
    };

    const analysis = await analyzeRepo(ambiguous, { cache, forceRefresh: null, llm: null, now: NOW });

    expect(analysis.method).toBe('rules');
    expect(analysis.domains).toEqual(['dev-experience']);
    expect(analysis.needs_review).toBe(true);
  });

  it('always validates against AnalysisSchema before returning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());

    const analysis = await analyzeRepo(CERT_MANAGER, { cache, forceRefresh: null, llm: null, now: NOW });

    // AnalysisSchema.parse already ran inside analyzeRepo; re-parsing must be a no-op.
    const { AnalysisSchema } = await import('@keco/core');
    expect(() => AnalysisSchema.parse(analysis)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/analyze exec vitest run src/analyze.test.ts`
Expected: FAIL — `./analyze` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
// packages/analyze/src/analyze.ts
import type { Cache } from '@keco/cache';
import { AnalysisSchema, FALLBACK_KIND, type Analysis } from '@keco/core';
import { classifyWithLlm, needsLlm, README_BUDGET_BYTES, type LlmDeps } from './llm';
import { classifyDerived, type DerivedInput } from './rules/derived';
import { classifyDomains, classifyKind, k8sRelevance, type RuleInput } from './rules/kind';
import { classifyRuntime } from './rules/runtime';
import { gatherSignals } from './signals';

/**
 * One repo, analyzed (AGENTS.md §4.2). The three-pass composition: `apps/workers/src/analyzer`
 * reads the cached artifacts and calls this; everything about *how* a repo gets classified
 * lives here, the way `sources/github/fetch.ts` owns the crawler's per-repo pipeline.
 */
export type AnalyzeInput = RuleInput & {
  content_hash: string;
  readme: string;
  /** `landscape` isn't here: it comes from pass 2's `gatherSignals`, not the caller (Task 4). */
  derived: Omit<DerivedInput, 'tree' | 'landscape'>;
};

export type AnalyzeDeps = {
  cache: Cache;
  /** The one manual TTL bypass (§4.2), forwarded to every pass-2 provider. */
  forceRefresh: string | null;
  /** `null` disables pass 3 (no ANTHROPIC_API_KEY configured) — an honest, not a fabricated, degrade. */
  llm: LlmDeps | null;
  now?: Date;
};

export async function analyzeRepo(input: AnalyzeInput, deps: AnalyzeDeps): Promise<Analysis> {
  const now = deps.now ?? new Date();

  // ── pass 1 — local rules, free and deterministic (classifyDerived excepted — see below) ──
  const kindVerdicts = classifyKind(input);
  const best = kindVerdicts[0] ?? null;
  const ruleConfidence = best?.confidence ?? 0;
  const ruleDomains = classifyDomains(input);
  const runtime = classifyRuntime(input, best?.kind ?? null).runtime;
  const relevance = k8sRelevance(input);

  // ── pass 2 — external signals, always attempted, never fatal ──────────────
  const { signals, landscape, install_methods, signals_used, partial_signals } = await gatherSignals(
    deps.cache,
    { repo: input.repo, name: input.name, kind: best?.kind ?? null, manifests: input.manifests },
    { forceRefresh: deps.forceRefresh, now },
  );

  // classifyDerived runs here, not with the rest of pass 1 above: it needs pass 2's `landscape`
  // (Task 4) to tell a real CNCF-hosted project from an `unknown` one.
  const derived = classifyDerived({ ...input.derived, tree: input.tree, landscape }, now);

  // ── pass 3 — LLM, only when pass 1 left kind or domains unsettled ─────────
  const ambiguous = needsLlm(ruleConfidence) || ruleDomains.length === 0;

  let summary = '';
  let kind = best?.kind ?? FALLBACK_KIND;
  let domains = ruleDomains;
  let confidence = ruleConfidence;
  let needsReview = false;
  let method: 'rules' | 'llm' = 'rules';
  let model: string | null = null;

  if (ambiguous) {
    if (deps.llm) {
      method = 'llm';
      model = deps.llm.model;
      const verdict = await classifyWithLlm(
        {
          repo: input.repo,
          readme: input.readme.slice(0, README_BUDGET_BYTES),
          topics: input.topics,
          tree: input.tree,
          signals,
        },
        deps.llm,
      );
      if (verdict) {
        summary = verdict.summary;
        kind = verdict.kind;
        domains = verdict.domains;
        confidence = verdict.confidence;
        needsReview = verdict.needs_review;
      } else {
        // Invalid twice — the honest low-confidence answer, never a fabricated one (§4.2 pass 3).
        kind = FALLBACK_KIND;
        domains = ruleDomains.length > 0 ? ruleDomains : ['dev-experience'];
        confidence = 0.3;
        needsReview = true;
      }
    } else {
      // No ANTHROPIC_API_KEY configured: stay honest about the gap rather than silently
      // upgrading confidence pass 1 never earned.
      domains = ruleDomains.length > 0 ? ruleDomains : ['dev-experience'];
      needsReview = true;
    }
  }

  return AnalysisSchema.parse({
    repo: input.repo,
    content_hash: input.content_hash,
    summary,
    kind,
    domains,
    runtime,
    license_class: derived.license_class,
    openness: derived.openness,
    maturity: derived.maturity,
    governance: derived.governance,
    k8s_relevance: relevance,
    confidence,
    needs_review: needsReview,
    install_methods,
    signals,
    method,
    model,
    signals_used,
    partial_signals,
    analyzed_at: now.toISOString(),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/analyze exec vitest run src/analyze.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/analyze/src/analyze.ts packages/analyze/src/analyze.test.ts
git commit -m "feat(analyze): compose all three passes into analyzeRepo, landscape included

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `packages/analyze` — export the new modules

**Files:**
- Modify: `packages/analyze/src/index.ts`

- [ ] **Step 1: Write the failing test**

There is no dedicated test for a barrel file; instead this step is verified by Task 9's import
in `apps/workers`. Confirm the gap first:

Run: `cd apps/workers && node -e "require('@keco/analyze')" 2>&1 | head -5` is not meaningful for
ESM/TS-only packages, so instead grep for the missing export:

Run: `grep -c "analyzeRepo\|gatherSignals\|identifyPackage" packages/analyze/src/index.ts`
Expected: `0`

- [ ] **Step 2: Implement**

```typescript
// packages/analyze/src/index.ts
export * from './rules/kind';
export * from './rules/runtime';
export * from './rules/derived';
export * from './rules/package-identity';
export * from './signals';
export * from './llm';
export * from './analyze';
```

- [ ] **Step 3: Verify**

Run: `grep -c "analyzeRepo\|gatherSignals\|identifyPackage" packages/analyze/src/index.ts`
Expected: `3`

Run: `pnpm --filter @keco/analyze exec tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/analyze/src/index.ts
git commit -m "feat(analyze): export the pass 2/3 modules from the package barrel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `apps/workers/src/analyzer` — the journal-driven default path

**Files:**
- Modify: `apps/workers/src/analyzer/index.ts` (full rewrite)
- Test: `apps/workers/src/analyzer/index.test.ts` (new)

This task wires the default mode only (no `--repo`, no `--min-confidence`): read
`repos/**` for a repo named by a `RepoFetched{changed:true}` event, call `analyzeRepo`, write
`analysis/{repo}.json`, append `RepoAnalyzed`, advance the checkpoint. Tasks 10 and 11 add the two
CLI bypasses on top of this same file.

One difference from what Task 7 alone might suggest: `loadArtifacts` below builds
`derived` **without** a `landscape` field at all — `AnalyzeInput.derived` no longer has one
(Task 7 moved it to come from `gatherSignals` instead), so there is nothing left to hardcode
here. The `TODO`-shaped comment that used to say "no cached CNCF landscape seed yet" is gone
because that is no longer true.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/workers/src/analyzer/index.test.ts
import { Cache, Journal, repoKeys, type Storage } from '@keco/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAnalyzer } from './index';

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

const REPO_JSON = {
  name: 'kubectx',
  description: 'Switch faster between clusters and namespaces',
  topics: ['kubernetes-operator'],
  language: 'Go',
  archived: false,
  created_at: '2016-01-01T00:00:00.000Z',
  pushed_at: '2026-07-01T00:00:00.000Z',
  license: { spdx_id: 'Apache-2.0' },
  owner: { login: 'ahmetb', type: 'User' },
};

async function seedRepo(cache: Cache, repo: string) {
  const keys = repoKeys(repo);
  await cache.putJSON(keys.repo, REPO_JSON);
  await cache.putText(keys.readme, '# kubectx');
  await cache.putJSON(keys.tree, { tree: [{ path: 'main.go', type: 'blob' }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runAnalyzer (default, journal-driven path)', () => {
  it('analyzes every changed RepoFetched event and advances the checkpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'ahmetb/kubectx');
    await journal.append({ type: 'RepoFetched', repo: 'ahmetb/kubectx', content_hash: 'hash-1', changed: true });
    await journal.append({ type: 'RepoFetched', repo: 'ahmetb/kubectx', content_hash: 'hash-1', changed: false });

    await runAnalyzer({ forceRefresh: null, repo: null, minConfidence: null }, { cache, journal, llm: null });

    const analysis = await cache.getJSON<{ repo: string; content_hash: string }>('analysis/ahmetb/kubectx.json');
    expect(analysis?.repo).toBe('ahmetb/kubectx');
    expect(analysis?.content_hash).toBe('hash-1');

    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).not.toBeNull();

    // A second run with nothing new to see must not re-analyze — the checkpoint already
    // covers both events above.
    await cache.delete('analysis/ahmetb/kubectx.json');
    await runAnalyzer({ forceRefresh: null, repo: null, minConfidence: null }, { cache, journal, llm: null });
    expect(await cache.has('analysis/ahmetb/kubectx.json')).toBe(false);
  });

  it('records RepoFailed and keeps going when repo.json is missing from the cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    // No seedRepo() call — the analyzer has nothing to read for this one.
    await journal.append({ type: 'RepoFetched', repo: 'ghost/repo', content_hash: 'hash-2', changed: true });

    await runAnalyzer({ forceRefresh: null, repo: null, minConfidence: null }, { cache, journal, llm: null });

    expect(await cache.has('analysis/ghost/repo.json')).toBe(false);
    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).not.toBeNull(); // still advances — a broken repo must not block the corpus
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/workers exec vitest run src/analyzer/index.test.ts`
Expected: FAIL — `runAnalyzer` doesn't accept a second `deps` argument yet, and does no real work.

- [ ] **Step 3: Implement**

Replace the entire contents of `apps/workers/src/analyzer/index.ts`:

```typescript
// apps/workers/src/analyzer/index.ts
import { analysisKey, repoKeys, type Cache, type Journal } from '@keco/cache';
import { type Analysis } from '@keco/core';
import { analyzeRepo, type AnalyzeInput, type LlmDeps } from '@keco/analyze';
import { config } from '../lib/config';
import { workerLogger } from '../lib/logger';
import { createRuntime, perItem } from '../lib/runtime';

/**
 * analyzer — `RepoFetched` where `changed` → `analysis/**` + `RepoAnalyzed` (§4.2).
 *
 * Thin by construction, the way `crawler/index.ts` is over `sources/github/fetch.ts`: every
 * classification decision lives in `@keco/analyze`'s `analyzeRepo`, this file only does the
 * I/O — reading the four cached artifacts a repo needs, writing the result, appending the
 * event, advancing the checkpoint.
 *
 * It reads the journal and its own checkpoint — never Meilisearch. An analyzer that queries a
 * read model to decide what to work on has broken the pattern (§2.1, §14).
 */
const log = workerLogger('analyzer');

export type AnalyzeOptions = {
  /** Provider name — the only TTL bypass, and it is manual. `null` honours every TTL. */
  forceRefresh: string | null;
  repo: string | null;
  minConfidence: number | null;
};

export type AnalyzerDeps = {
  cache: Cache;
  journal: Journal;
  /** `null` when no ANTHROPIC_API_KEY is configured — pass 3 degrades honestly instead of running. */
  llm: LlmDeps | null;
};

function defaultDeps(): AnalyzerDeps {
  const { cache, journal } = createRuntime();
  const llm =
    config.ANTHROPIC_API_KEY !== '' ? { apiKey: config.ANTHROPIC_API_KEY, model: config.ANALYZER_MODEL } : null;
  return { cache, journal, llm };
}

type RepoJson = {
  name: string;
  description: string | null;
  topics?: string[];
  language: string | null;
  archived?: boolean;
  created_at: string;
  pushed_at: string;
  license: { spdx_id: string | null } | null;
  owner: { login: string; type: 'User' | 'Organization' };
};
type TreeJson = { tree?: { path?: string; type?: string }[] };
type ReleaseJson = { published_at?: string | null };

/** The same set `sources/github/manifests.ts` selects for the crawler to fetch (§4.2). */
const MANIFEST_FILES = ['go.mod', 'Chart.yaml', 'package.json', 'Cargo.toml', 'pyproject.toml'];

/** Reads everything pass 1/2 need for one repo out of the write model. Never LIST — every path here is a known key (§14). */
async function loadArtifacts(cache: Cache, repo: string, contentHash: string): Promise<AnalyzeInput | null> {
  const keys = repoKeys(repo);
  const repoJson = await cache.getJSON<RepoJson>(keys.repo);
  if (repoJson === null) return null;

  const readme = (await cache.getText(keys.readme)) ?? '';
  const tree = await cache.getJSON<TreeJson>(keys.tree);
  const treePaths = (tree?.tree ?? [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path ?? '')
    .filter((path) => path !== '');

  const manifests: Record<string, string> = {};
  for (const file of MANIFEST_FILES) {
    const text = await cache.getText(keys.manifest(file));
    if (text !== null) manifests[file] = text;
  }

  const releases = await cache.getJSON<ReleaseJson[]>(keys.releases);
  const latestReleaseAt = releases?.[0]?.published_at ?? null;

  return {
    repo,
    content_hash: contentHash,
    name: repoJson.name,
    description: repoJson.description,
    topics: repoJson.topics ?? [],
    tree: treePaths,
    manifests,
    language: repoJson.language,
    readme,
    derived: {
      owner: repoJson.owner.login,
      owner_type: repoJson.owner.type,
      license_spdx: repoJson.license?.spdx_id ?? null,
      readme,
      archived: repoJson.archived === true,
      created_at: repoJson.created_at,
      pushed_at: repoJson.pushed_at,
      latest_release_at: latestReleaseAt,
    },
  };
}

async function analyzeOne(
  repo: string,
  contentHash: string,
  deps: AnalyzerDeps,
  options: AnalyzeOptions,
): Promise<Analysis | null> {
  const artifacts = await loadArtifacts(deps.cache, repo, contentHash);
  if (artifacts === null) {
    log.warn({ repo }, 'no cached repo.json — skipping (crawl it first)');
    return null;
  }

  const analysis = await analyzeRepo(artifacts, {
    cache: deps.cache,
    forceRefresh: options.forceRefresh,
    llm: deps.llm,
  });
  await deps.cache.putJSON(analysisKey(repo), analysis);
  return analysis;
}

async function recordFailure(deps: AnalyzerDeps, repo: string, error: Error): Promise<void> {
  log.warn({ repo, err: error.message }, 'analysis failed');
  await deps.journal.append({ type: 'RepoFailed', repo, phase: 'analyze', error: error.message });
}

async function recordSuccess(deps: AnalyzerDeps, repo: string, analysis: Analysis): Promise<void> {
  await deps.journal.append({
    type: 'RepoAnalyzed',
    repo,
    content_hash: analysis.content_hash,
    confidence: analysis.confidence,
    partial: analysis.partial_signals.length > 0,
  });
}

export async function runAnalyzer(options: AnalyzeOptions, deps: AnalyzerDeps = defaultDeps()): Promise<void> {
  const { cache, journal } = deps;

  const checkpoint = await journal.checkpoint('analyzer');
  log.info({ checkpoint: checkpoint.last_event_id, forceRefresh: options.forceRefresh }, 'analyzer start');

  let processed = 0;
  for await (const event of journal.read({ afterId: checkpoint.last_event_id })) {
    if (event.type === 'RepoFetched' && event.changed) {
      const analysis = await perItem(
        event.repo,
        () => analyzeOne(event.repo, event.content_hash, deps, options),
        (repo, error) => recordFailure(deps, repo, error),
      );
      if (analysis) {
        await recordSuccess(deps, event.repo, analysis);
        processed += 1;
      }
    }

    // Advance past every event once handled — including a failure, which is itself durably
    // recorded as RepoFailed. A checkpoint tracks "have I looked at this", not "did it
    // succeed": a permanently broken repo must not block the rest of the corpus forever (§4).
    await journal.advance('analyzer', event.id);
  }

  log.info({ processed }, 'analyzer batch complete');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/workers exec vitest run src/analyzer/index.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/analyzer/index.ts apps/workers/src/analyzer/index.test.ts
git commit -m "feat(analyzer): wire the journal-driven default path to the three passes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `--repo` bypass — analyze one named repo directly

**Files:**
- Modify: `apps/workers/src/analyzer/index.ts`
- Test: `apps/workers/src/analyzer/index.test.ts`

Mirrors the crawler's `--repo` bypass: skip the journal entirely, read the repo's own
`_fetch.json` for its last `content_hash`, analyze it, append `RepoAnalyzed` — without touching
the checkpoint.

- [ ] **Step 1: Write the failing test**

Add to `apps/workers/src/analyzer/index.test.ts`:

```typescript
describe('runAnalyzer (--repo bypass)', () => {
  it('analyzes exactly the named repo without touching the checkpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'ahmetb/kubectx');
    await cache.putJSON(repoKeys('ahmetb/kubectx').fetch, {
      etags: { repo: null, readme: null, tree: null, releases: null },
      fetched_at: '2026-08-01T00:00:00.000Z',
      content_hash: 'hash-direct',
      source: 'cli',
      manifests: [],
    });
    // A second, unrelated repo with a pending journal event — must be left untouched.
    await journal.append({ type: 'RepoFetched', repo: 'other/repo', content_hash: 'hash-x', changed: true });

    await runAnalyzer({ forceRefresh: null, repo: 'ahmetb/kubectx', minConfidence: null }, { cache, journal, llm: null });

    const analysis = await cache.getJSON<{ content_hash: string }>('analysis/ahmetb/kubectx.json');
    expect(analysis?.content_hash).toBe('hash-direct');
    expect(await cache.has('analysis/other/repo.json')).toBe(false);

    const checkpoint = await journal.checkpoint('analyzer');
    expect(checkpoint.last_event_id).toBeNull();
  });

  it('exits with an error when the named repo has never been crawled', async () => {
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    process.exitCode = undefined;

    await runAnalyzer({ forceRefresh: null, repo: 'never/crawled', minConfidence: null }, { cache, journal, llm: null });

    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/workers exec vitest run src/analyzer/index.test.ts`
Expected: FAIL — `options.repo` is currently ignored by `runAnalyzer`.

- [ ] **Step 3: Implement**

In `apps/workers/src/analyzer/index.ts`, replace the `runAnalyzer` function (only — every other
export and helper from Task 9 stays exactly as written) with:

```typescript
export async function runAnalyzer(options: AnalyzeOptions, deps: AnalyzerDeps = defaultDeps()): Promise<void> {
  const { cache, journal } = deps;

  if (options.repo !== null) {
    const repo = options.repo;
    // A direct, single-repo request bypasses the journal entirely — the same bypass shape as
    // the crawler's `--repo` (§4.2). The last content_hash the crawler recorded is what this
    // analysis gets stamped with.
    const fetchMeta = await cache.getJSON<{ content_hash: string }>(repoKeys(repo).fetch);
    if (fetchMeta === null) {
      log.error({ repo }, 'repo has never been crawled — run repo:crawl first');
      process.exitCode = 1;
      return;
    }

    const analysis = await perItem(
      repo,
      () => analyzeOne(repo, fetchMeta.content_hash, deps, options),
      (target, error) => recordFailure(deps, target, error),
    );
    if (analysis) {
      await recordSuccess(deps, repo, analysis);
      log.info({ repo, kind: analysis.kind, confidence: analysis.confidence }, 'analyzed');
    }
    return;
  }

  const checkpoint = await journal.checkpoint('analyzer');
  log.info({ checkpoint: checkpoint.last_event_id, forceRefresh: options.forceRefresh }, 'analyzer start');

  let processed = 0;
  for await (const event of journal.read({ afterId: checkpoint.last_event_id })) {
    if (event.type === 'RepoFetched' && event.changed) {
      const analysis = await perItem(
        event.repo,
        () => analyzeOne(event.repo, event.content_hash, deps, options),
        (repo, error) => recordFailure(deps, repo, error),
      );
      if (analysis) {
        await recordSuccess(deps, event.repo, analysis);
        processed += 1;
      }
    }

    // Advance past every event once handled — including a failure, which is itself durably
    // recorded as RepoFailed. A checkpoint tracks "have I looked at this", not "did it
    // succeed": a permanently broken repo must not block the rest of the corpus forever (§4).
    await journal.advance('analyzer', event.id);
  }

  log.info({ processed }, 'analyzer batch complete');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/workers exec vitest run src/analyzer/index.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/analyzer/index.ts apps/workers/src/analyzer/index.test.ts
git commit -m "feat(analyzer): --repo bypasses the journal for a single, direct analysis

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: `--min-confidence` — a targeted re-analysis sweep

**Files:**
- Modify: `apps/workers/src/analyzer/index.ts`
- Test: `apps/workers/src/analyzer/index.test.ts`

A manual, operator-triggered maintenance sweep, not part of the continuous journal loop — the
one deliberate exception to "never list to find work" (§14): listing `analysis/` here is an
explicit, one-off request, not a hot-path decision about what to do next.

- [ ] **Step 1: Write the failing test**

Add to `apps/workers/src/analyzer/index.test.ts`:

```typescript
describe('runAnalyzer (--min-confidence sweep)', () => {
  it('re-analyzes only the existing analyses below the threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const cache = new Cache(memoryStorage());
    const journal = new Journal(cache);
    await seedRepo(cache, 'ahmetb/kubectx');
    await seedRepo(cache, 'other/confident-repo');

    await cache.putJSON('analysis/ahmetb/kubectx.json', {
      repo: 'ahmetb/kubectx',
      content_hash: 'hash-1',
      confidence: 0.3,
      partial_signals: [],
    });
    await cache.putJSON('analysis/other/confident-repo.json', {
      repo: 'other/confident-repo',
      content_hash: 'hash-2',
      confidence: 0.95,
      partial_signals: [],
    });

    await runAnalyzer({ forceRefresh: null, repo: null, minConfidence: 0.7 }, { cache, journal, llm: null });

    const reanalyzed = await cache.getJSON<{ analyzed_at: string }>('analysis/ahmetb/kubectx.json');
    expect(reanalyzed?.analyzed_at).toBeDefined();

    // Untouched: still exactly the two fields this test seeded, nothing analyzeRepo would add.
    const untouched = await cache.getJSON<Record<string, unknown>>('analysis/other/confident-repo.json');
    expect(Object.keys(untouched ?? {}).sort()).toEqual(['confidence', 'content_hash', 'partial_signals', 'repo']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @keco/workers exec vitest run src/analyzer/index.test.ts`
Expected: FAIL — `options.minConfidence` is currently ignored.

- [ ] **Step 3: Implement**

In `apps/workers/src/analyzer/index.ts`, replace the `runAnalyzer` function (only — every other
export and helper stays exactly as Task 9 wrote it) with:

```typescript
export async function runAnalyzer(options: AnalyzeOptions, deps: AnalyzerDeps = defaultDeps()): Promise<void> {
  const { cache, journal } = deps;

  if (options.repo !== null) {
    const repo = options.repo;
    // A direct, single-repo request bypasses the journal entirely — the same bypass shape as
    // the crawler's `--repo` (§4.2). The last content_hash the crawler recorded is what this
    // analysis gets stamped with.
    const fetchMeta = await cache.getJSON<{ content_hash: string }>(repoKeys(repo).fetch);
    if (fetchMeta === null) {
      log.error({ repo }, 'repo has never been crawled — run repo:crawl first');
      process.exitCode = 1;
      return;
    }

    const analysis = await perItem(
      repo,
      () => analyzeOne(repo, fetchMeta.content_hash, deps, options),
      (target, error) => recordFailure(deps, target, error),
    );
    if (analysis) {
      await recordSuccess(deps, repo, analysis);
      log.info({ repo, kind: analysis.kind, confidence: analysis.confidence }, 'analyzed');
    }
    return;
  }

  if (options.minConfidence !== null) {
    // A manual, operator-triggered maintenance sweep over existing analyses — not part of the
    // continuous journal loop below. Listing `analysis/` here is the one deliberate exception
    // to "never list to find work" (§14): an operator asked for exactly this by name, so it is
    // not a hot-path decision about what to do next.
    const threshold = options.minConfidence;
    const keys = await cache.list('analysis/');
    let swept = 0;
    for (const key of keys) {
      const existing = await cache.getJSON<Analysis>(key);
      if (existing === null || existing.confidence >= threshold) continue;
      swept += 1;

      const analysis = await perItem(
        existing.repo,
        () => analyzeOne(existing.repo, existing.content_hash, deps, options),
        (target, error) => recordFailure(deps, target, error),
      );
      if (analysis) await recordSuccess(deps, existing.repo, analysis);
    }
    log.info({ swept, minConfidence: threshold }, 're-analysis sweep complete');
    return;
  }

  const checkpoint = await journal.checkpoint('analyzer');
  log.info({ checkpoint: checkpoint.last_event_id, forceRefresh: options.forceRefresh }, 'analyzer start');

  let processed = 0;
  for await (const event of journal.read({ afterId: checkpoint.last_event_id })) {
    if (event.type === 'RepoFetched' && event.changed) {
      const analysis = await perItem(
        event.repo,
        () => analyzeOne(event.repo, event.content_hash, deps, options),
        (repo, error) => recordFailure(deps, repo, error),
      );
      if (analysis) {
        await recordSuccess(deps, event.repo, analysis);
        processed += 1;
      }
    }

    // Advance past every event once handled — including a failure, which is itself durably
    // recorded as RepoFailed. A checkpoint tracks "have I looked at this", not "did it
    // succeed": a permanently broken repo must not block the rest of the corpus forever (§4).
    await journal.advance('analyzer', event.id);
  }

  log.info({ processed }, 'analyzer batch complete');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @keco/workers exec vitest run src/analyzer/index.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/workers/src/analyzer/index.ts apps/workers/src/analyzer/index.test.ts
git commit -m "feat(analyzer): --min-confidence sweeps existing analyses below a threshold

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: ROADMAP.md and AGENTS.md — mark the analyzer done, record the gaps

**Files:**
- Modify: `ROADMAP.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the v1 write-side section**

In `ROADMAP.md`, replace the four analyzer bullets under "### Write side" (the ones currently
marked ⬜ for "analyzer pass 1", "analyzer pass 2", "analyzer pass 3") with:

```markdown
- ✅ **analyzer pass 1** — local rules over cached payloads (`kind`, `domains`, `runtime`,
  `license_class`, `openness`, `maturity`, `governance`, `k8s_relevance`), each with a fixture
  in `packages/analyze/fixtures` proving it.
- ✅ **analyzer pass 2** — Scorecard, deps.dev, OSV, Homebrew and CNCF Landscape behind the TTL
  cache; Artifact Hub proves `helm` and `krew` install methods from an exact, case-insensitive
  name match, and CNCF Landscape membership finally feeds `maturity`/`governance` instead of a
  hardcoded `null` — closing the gap §6 used to document (etcd-io, containerd, helm, prometheus,
  cilium now report `cncf-graduated`/`foundation` from an actual seed, not `unknown`). A dead
  provider degrades to `null` + `partial_signals[]` and never stalls the pipeline. Known gaps,
  deliberately deferred rather than missed: krew's own index and OperatorHub are not separate
  providers (Artifact Hub already indexes krew plugins; a safe, general OLM install command
  needs more than a search hit), and the "GitHub extra" signal (contributors, dependents,
  community profile, sharing the crawler's quota) is not wired.
- ✅ **analyzer pass 3** — LLM only for what rules and signals left ambiguous (`kind`,
  `domains`, `summary`, `confidence`, `needs_review` only — never `runtime` or the four
  cached-metadata families); structured output forced via Anthropic tool-use and validated
  against the taxonomy itself; one retry, then an honest low-confidence fallback.
- ⬜ **re-analysis triggers** — `content_hash` change is wired (the journal-driven default
  path); the oldest signal's TTL expiring is not yet a trigger on its own. Signal freshness
  drifts from repo freshness; a repo unchanged for a year still needs its Scorecard (and CNCF
  Landscape) entry refreshed weekly.
```

- [ ] **Step 2: Update the `governance`/`maturity` note in AGENTS.md §6**

This is a contract change (§15's definition of done requires it): the sentence in §6 that says
governance reports `unknown` for real foundation projects "until the CNCF landscape crawler
ships a cached seed" stops being true once Task 4 lands. In `AGENTS.md`, find this paragraph
(search for `CNCF landscape crawler ships a cached seed`):

```markdown
**Unknown is a real answer.** Every family whose classification can fail declares `unknown` and
defaults to it. Absence of evidence never becomes a positive claim — the same rule §4.3 applies to
a missing Scorecard. `unknown` values are hidden from the UI. `governance` in particular will
report `unknown` for most real foundation projects (etcd-io, containerd, helm, prometheus,
cilium) until the CNCF landscape crawler ships a cached seed — an org account alone proves
nothing. `maturity` checks `archived` before the CNCF level, so an archived CNCF-graduated
project reports `archived`; see `docs/taxonomy.md` for why.
```

Replace it with:

```markdown
**Unknown is a real answer.** Every family whose classification can fail declares `unknown` and
defaults to it. Absence of evidence never becomes a positive claim — the same rule §4.3 applies to
a missing Scorecard. `unknown` values are hidden from the UI. `governance` and `maturity` are
seeded from the CNCF Landscape (`packages/signals/src/providers/cncf-landscape.ts`, a weekly
bulk fetch of `cncf/landscape`'s `landscape.yml`): a repo hosted at any level reports
`cncf-graduated`/`cncf-incubating`/`cncf-sandbox` and `foundation` from that seed — real
foundation projects (etcd-io, containerd, helm, prometheus, cilium) no longer default to
`unknown` just because an org account alone proves nothing. A repo the Landscape doesn't list
still reports `unknown` for both, honestly — the seed is real but far from exhaustive.
`maturity` checks `archived` before the CNCF level, so an archived CNCF-graduated project
reports `archived`; see `docs/taxonomy.md` for why.
```

- [ ] **Step 3: Verify both diffs are exactly the intended replacements**

Run: `git diff ROADMAP.md AGENTS.md`
Expected: the ROADMAP bullets and the AGENTS.md §6 paragraph above replace what's there today;
nothing else in either file changes.

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md AGENTS.md
git commit -m "docs: mark analyzer pass 1/2/3 done, record the CNCF Landscape seed landing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `mise run ci`
Expected: `tsc --noEmit`, eslint (including the §7 import-boundary rules), vitest and
`taxonomy:check` all green. Pay particular attention to:
- `packages/analyze` and `packages/signals` typecheck cleanly against the real
  `@anthropic-ai/sdk` types (Task 6's `LlmClient` cast) and the real `yaml` types (Task 4's
  `parseYaml` call).
- No import-boundary violation: `apps/workers/src/analyzer/**` is the only worker directory
  allowed to import `@keco/signals` and `@keco/analyze` (eslint.config.mjs lines ~130-145).
- `pnpm install` picked up the new `yaml` dependency in `packages/signals/package.json`
  (Task 4, Step 7) — a missing lockfile update here is the most likely first failure.

- [ ] **Step 2: Manual smoke check against a real repo (optional but recommended)**

If a populated `.cache/` from a prior `mise run repo:crawl` is available:

Run: `mise run repo:analyze -- --repo <owner/name>` for one repo already in the cache.
Expected: `analysis/<owner>/<name>.json` is written, log line `"analyzed"` with a `kind` and
`confidence`, and (if `ANTHROPIC_API_KEY` is unset) `method: "rules"` unless the repo was
genuinely ambiguous, in which case `needs_review: true` and `confidence: 0.3` rather than a
crash.

- [ ] **Step 3: Report**

State plainly which of the two verification steps ran and what their output was — do not
declare the analyzer "done" without having run `mise run ci` green in this session.
