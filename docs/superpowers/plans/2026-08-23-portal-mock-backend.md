# Portal Mock Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/web` a believable corpus and a working README endpoint with no Docker, no network and no GitHub quota — for development and test only, provably absent from production builds.

**Architecture:** MSW intercepts at the network layer in the dev browser, so no application code branches on mock mode. A pure query engine implements the closed subset of the Meilisearch search API the portal actually issues (three filter forms, four sorts, facets, pagination) over a fixture corpus of `ToolDocument`s. Five independent layers keep it out of production, the load-bearing one being a scan of the built `dist/`.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), React 19, Vite 8, MSW 2, Vitest (node environment), zod via `@keco/core`.

**Spec:** `docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md`

---

## Background you need before starting

Read these three things; the tasks assume them.

**1. What the portal actually requests.** `apps/web/src/lib/search.ts` issues exactly two kinds
of Meilisearch call, and `apps/web/src/routes/tool.tsx:57` issues one API call:

| Request | Portal callers |
|---|---|
| `POST {host}/indexes/tools/search` | `searchTools`, `browseFacets`, `whatsHot`, `findAlternatives` |
| `GET {host}/indexes/tools/documents/:id` | `getTool` |
| `GET /api/readme/:owner/:repo` | the tool page's README panel |

**2. The filter and sort grammar is closed.** `buildFilters()` in `packages/core/src/read.ts`
can emit only three forms, and it always emits the last two:

```
kind IN ["cli", "operator"]        // one per selected taxonomy family, plus language / license
archived = false                   // unless includeArchived
k8s_relevance >= 0.4               // always, value from minRelevance
```

`sortSpec()` can emit only `[]`, `['stars:desc']`, `['score.total:desc']`,
`['score.momentum:desc']`, or `['pushed_at:desc']`. The engine is an evaluator for that finite
set — not a general Meilisearch implementation.

**3. Constraints that will bite you.**

- `packages/core/taxonomy.yaml` declares `domains` with `min: 1, max: 3`. **Every fixture
  document needs 1–3 domains** or `ToolDocument.parse` fails.
- `tsconfig.base.json` sets `noUncheckedIndexedAccess: true`. `array[0]` is
  `T | undefined`, and every code sample below is already written to satisfy that. Do not
  "simplify" the guards away.
- `vitest.config.ts` includes `apps/*/src/**/*.test.ts` — **`.ts` only, not `.tsx`**. All test
  files here are `.test.ts`.
- `eslint.config.mjs` builds `no-restricted-imports` through a `boundary()` helper. Flat config
  is last-match-wins **per rule key**, so a second config block naming
  `no-restricted-imports` for `apps/web/src` would *replace* the browser-bundle rule rather
  than add to it. Task 11 handles this specifically; do not shortcut it.

## File Structure

**Created — the mock itself (all under `apps/web/src/mocks/`, deliberately inside `src/` so the
§7 browser-bundle lint rule applies to it):**

| File | Responsibility |
|---|---|
| `corpus/builder.ts` | `makeTool()` — one complete `ToolDocument` default, so fixtures are overrides |
| `corpus/curated.ts` | ~30 hand-written documents for real projects |
| `corpus/generate.ts` | deterministic seeded generator padding the corpus |
| `corpus/index.ts` | assembles curated + generated, memoised; holds the build sentinel |
| `engine.ts` | pure `runSearch(corpus, request)` — filters, matching, sorting, facets, paging |
| `readmes.ts` | `full_name → { html, truncated }`, pre-sanitised HTML |
| `handlers.ts` | MSW handlers over the engine; imports isomorphic `msw` only |
| `browser.ts` | `setupWorker` — the only file importing `msw/browser` |
| `start.ts` | `startMocks()` — registration, banner, failure behaviour |

**Created — enforcement and typing:**

| File | Responsibility |
|---|---|
| `apps/web/src/vite-env.d.ts` | types `VITE_MOCK` on `ImportMetaEnv` |
| `apps/web/scripts/assert-no-mocks.ts` | `scanForMocks(dir)` + CLI; Layer 4 |

**Modified:** `apps/web/src/main.tsx`, `apps/web/package.json`, `eslint.config.mjs`,
`vitest.config.ts`, `mise.toml`, `.gitignore`, `.env.example`, `CLAUDE.md`,
`apps/web/README.md`, `ROADMAP.md`.

**Tests:** `corpus/corpus.test.ts`, `engine.test.ts`, `engine.pinning.test.ts`,
`handlers.test.ts`, `apps/web/scripts/assert-no-mocks.test.ts`.

---

### Task 1: Install MSW as a dev-only dependency

**Files:**
- Modify: `apps/web/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add msw to devDependencies**

This is Layer 2 of the invariant. `msw` goes in `devDependencies` and must never appear in
`dependencies` — a production install then cannot resolve it even if an import survived.

```bash
pnpm -F @keco/web add -D msw@^2.7.0
```

- [ ] **Step 2: Verify it landed in the right section**

Run: `node -e "const p=require('./apps/web/package.json'); console.log('dep:', p.dependencies.msw, 'dev:', p.devDependencies.msw)"`
Expected: `dep: undefined dev: ^2.7.0`

- [ ] **Step 3: Gitignore the generated service worker**

This is Layer 5. `vite build` copies `public/` verbatim into `dist/`, so the worker script must
never exist in a clean checkout. Append to `.gitignore`, after the `.data/` line:

```gitignore
# MSW worker script — generated by `mise run web:mock`, dev-only, must never reach dist/ (§9)
apps/web/public/mockServiceWorker.js
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml .gitignore
git commit -m "chore(web): add msw as a dev-only dependency"
```

---

### Task 2: The document builder

`makeTool()` supplies one complete, valid `ToolDocument`, so every fixture is a short override
instead of forty repeated fields. It derives identity from a single `repo: 'owner/name'`.

**Files:**
- Create: `apps/web/src/mocks/corpus/builder.ts`
- Test: `apps/web/src/mocks/corpus/builder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/mocks/corpus/builder.test.ts
import { ToolDocument, toDocumentId } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { makeTool } from './builder';

describe('makeTool', () => {
  it('derives identity from repo and produces a valid ToolDocument', () => {
    const tool = makeTool({ repo: 'derailed/k9s' });

    expect(tool.owner).toBe('derailed');
    expect(tool.name).toBe('k9s');
    expect(tool.full_name).toBe('derailed/k9s');
    expect(tool.id).toBe(toDocumentId('derailed/k9s'));
    expect(tool.repo_url).toBe('https://github.com/derailed/k9s');
    expect(() => ToolDocument.parse(tool)).not.toThrow();
  });

  it('lets overrides win over defaults', () => {
    const tool = makeTool({ repo: 'a/b', stars: 4200, kind: 'cli', domains: ['security'] });
    expect(tool.stars).toBe(4200);
    expect(tool.kind).toBe('cli');
    expect(tool.domains).toEqual(['security']);
  });

  it('derives has_scorecard from the scorecard signal unless overridden', () => {
    expect(makeTool({ repo: 'a/b' }).has_scorecard).toBe(true);
    const none = makeTool({ repo: 'a/b', signals: { scorecard: null, osv: null, dependents: null } });
    expect(none.has_scorecard).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/mocks/corpus/builder.test.ts`
Expected: FAIL — `Failed to resolve import "./builder"`

- [ ] **Step 3: Write the builder**

```ts
// apps/web/src/mocks/corpus/builder.ts
import { toDocumentId, type Signals, type ToolDocument } from '@keco/core';

/**
 * Mock fixture builder — development and test only (see the design spec's governing
 * invariant). Nothing outside `main.tsx`'s dev branch and test files may import this.
 *
 * One complete, schema-valid ToolDocument so a fixture is an override, not forty repeated
 * fields. Identity is derived from `repo` so `id`, `full_name` and `repo_url` cannot drift
 * apart across thirty hand-written entries.
 */
export type ToolOverrides = Partial<Omit<ToolDocument, 'id' | 'owner' | 'name' | 'full_name'>> & {
  repo: string;
};

const DEFAULT_SIGNALS: Signals = {
  scorecard: { score: 7.2, checks: { 'Code-Review': 8, 'CI-Tests': 10, Maintained: 9 }, fetched_at: '2026-08-20T00:00:00.000Z' },
  osv: { open_vulns: 0, fetched_at: '2026-08-20T00:00:00.000Z' },
  dependents: 120,
};

export function makeTool(overrides: ToolOverrides): ToolDocument {
  const { repo, ...rest } = overrides;
  const [owner = 'unknown-owner', name = 'unknown-repo'] = repo.split('/');
  const signals = rest.signals ?? DEFAULT_SIGNALS;

  return {
    id: toDocumentId(repo),
    owner,
    name,
    full_name: repo,
    description: `${name} — a Kubernetes ecosystem project.`,
    homepage: null,
    repo_url: `https://github.com/${repo}`,

    stars: 1200,
    forks: 140,
    open_issues: 30,
    language: 'Go',
    license: 'Apache-2.0',
    github_topics: ['kubernetes'],
    archived: false,
    pushed_at: '2026-08-01T00:00:00.000Z',
    created_at: '2019-03-01T00:00:00.000Z',
    discovery_source: 'mock',

    summary: `${name} is a Kubernetes ecosystem project used for mock development.`,
    kind: 'service',
    // taxonomy.yaml declares domains min: 1 — an empty array fails ToolDocument.parse.
    domains: ['dev-experience'],
    runtime: 'in-cluster',
    license_class: 'permissive',
    openness: 'fully-open',
    maturity: 'established',
    governance: 'community',
    k8s_relevance: 0.9,
    confidence: 0.85,
    needs_review: false,
    install_methods: [],

    score: {
      popularity: 0.55,
      activity: 0.7,
      adoption: 0.4,
      quality: 0.75,
      quality_coverage: 0.8,
      total: 0.6,
      momentum: 0.5,
    },
    signals,
    has_scorecard: signals.scorecard !== null,
    has_release: true,

    readme_excerpt: `# ${name}\n\nMock README excerpt for ${repo}.`,

    analysis_method: 'rules',
    analysis_model: null,
    content_hash: `mock-${toDocumentId(repo)}`,
    signals_used: ['scorecard'],
    indexed_at: '2026-08-23T00:00:00.000Z',

    ...rest,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/web/src/mocks/corpus/builder.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/mocks/corpus/builder.ts apps/web/src/mocks/corpus/builder.test.ts
git commit -m "feat(web): add a mock ToolDocument builder for dev fixtures"
```

---

### Task 3: The curated corpus

~30 documents for real, recognisable projects, chosen to span the taxonomy rather than to be a
top-30 list. A reviewer can only judge whether a card looks right if it describes something
they recognise.

**Files:**
- Create: `apps/web/src/mocks/corpus/curated.ts`

- [ ] **Step 1: Write the curated documents**

Note the deliberate variety at the end of the list: an archived project, one with no verified
install method, one with no Scorecard, one needing review, and several with
`governance: 'unknown'` — because most real foundation projects report exactly that today (§6).
`install_methods` entries appear only where the registry entry genuinely exists.

```ts
// apps/web/src/mocks/corpus/curated.ts
import type { ToolDocument } from '@keco/core';
import { makeTool } from './builder';

/**
 * Mock fixture data — development and test only. Real projects, honest taxonomy values.
 *
 * `install_methods` are written only where the registry entry genuinely exists, with its real
 * source_url. §6 calls a fabricated `brew install` line the worst bug this project can ship,
 * and a fixture that teaches the wrong shape is how one gets written.
 */
export const CURATED: ToolDocument[] = [
  makeTool({
    repo: 'argoproj/argo-cd',
    description: 'Declarative continuous deployment for Kubernetes',
    summary: 'GitOps continuous delivery controller that syncs cluster state from Git repositories.',
    kind: 'controller', domains: ['gitops', 'ci-cd'], runtime: 'in-cluster',
    stars: 20100, forks: 6100, language: 'Go', maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'gitops', 'continuous-delivery', 'argocd'],
    score: { popularity: 0.86, activity: 0.92, adoption: 0.88, quality: 0.9, quality_coverage: 1, total: 0.89, momentum: 0.72 },
  }),
  makeTool({
    repo: 'cilium/cilium',
    description: 'eBPF-based networking, observability and security',
    summary: 'eBPF-based CNI providing networking, observability and network policy enforcement.',
    kind: 'controller', domains: ['networking', 'security', 'observability'], runtime: 'in-cluster',
    stars: 21500, forks: 3200, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'ebpf', 'networking', 'cni'],
    score: { popularity: 0.87, activity: 0.95, adoption: 0.84, quality: 0.92, quality_coverage: 1, total: 0.9, momentum: 0.8 },
  }),
  makeTool({
    repo: 'derailed/k9s',
    description: 'Kubernetes CLI to manage your clusters in style',
    summary: 'Terminal UI for navigating, observing and managing live Kubernetes clusters.',
    kind: 'cli', domains: ['dev-experience', 'troubleshooting'], runtime: 'workstation',
    stars: 28900, forks: 1800, maturity: 'established', governance: 'individual',
    github_topics: ['kubernetes', 'cli', 'terminal', 'k9s'],
    install_methods: [
      { method: 'brew', command: 'brew install k9s', source_url: 'https://formulae.brew.sh/formula/k9s', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.9, activity: 0.85, adoption: 0.7, quality: 0.78, quality_coverage: 0.75, total: 0.84, momentum: 0.66 },
  }),
  makeTool({
    repo: 'helm/helm',
    description: 'The Kubernetes package manager',
    summary: 'Packages Kubernetes manifests as versioned, templated charts and installs them.',
    kind: 'cli', domains: ['packaging'], runtime: 'workstation',
    stars: 27400, forks: 7100, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'helm', 'package-manager', 'charts'],
    install_methods: [
      { method: 'brew', command: 'brew install helm', source_url: 'https://formulae.brew.sh/formula/helm', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.89, activity: 0.8, adoption: 0.95, quality: 0.88, quality_coverage: 1, total: 0.88, momentum: 0.4 },
  }),
  makeTool({
    repo: 'cert-manager/cert-manager',
    description: 'Automatically provision and manage TLS certificates in Kubernetes',
    summary: 'Operator that issues and renews X.509 certificates from ACME and internal CAs.',
    kind: 'operator', domains: ['security', 'secrets'], runtime: 'in-cluster',
    stars: 12600, forks: 2100, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'tls', 'certificates', 'acme'],
    score: { popularity: 0.8, activity: 0.86, adoption: 0.82, quality: 0.87, quality_coverage: 1, total: 0.84, momentum: 0.45 },
  }),
  makeTool({
    repo: 'ahmetb/kubectx',
    description: 'Faster way to switch between clusters and namespaces in kubectl',
    summary: 'Two small tools for switching kubectl contexts and namespaces quickly.',
    kind: 'kubectl-plugin', domains: ['dev-experience'], runtime: 'workstation',
    stars: 18200, forks: 1300, maturity: 'established', governance: 'individual',
    github_topics: ['kubernetes', 'kubectl', 'kubectl-plugin', 'kubernetes-cli'],
    install_methods: [
      { method: 'brew', command: 'brew install kubectx', source_url: 'https://formulae.brew.sh/formula/kubectx', verified_at: '2026-08-20T00:00:00.000Z' },
      { method: 'krew', command: 'kubectl krew install ctx', source_url: 'https://krew.sigs.k8s.io/plugins/', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.85, activity: 0.5, adoption: 0.78, quality: 0.7, quality_coverage: 0.6, total: 0.75, momentum: 0.3 },
  }),
  makeTool({
    repo: 'external-secrets/external-secrets',
    description: 'Sync secrets from external APIs into Kubernetes',
    summary: 'Operator that reads secrets from external stores and materialises them as Secrets.',
    kind: 'operator', domains: ['secrets', 'security'], runtime: 'in-cluster',
    stars: 5400, forks: 1000, maturity: 'cncf-incubating', governance: 'foundation',
    github_topics: ['kubernetes', 'secrets', 'vault', 'operator'],
    score: { popularity: 0.68, activity: 0.84, adoption: 0.6, quality: 0.8, quality_coverage: 0.9, total: 0.73, momentum: 0.6 },
  }),
  makeTool({
    repo: 'prometheus-operator/prometheus-operator',
    description: 'Prometheus Operator creates/configures/manages Prometheus clusters',
    summary: 'Manages Prometheus, Alertmanager and their configuration through custom resources.',
    kind: 'operator', domains: ['observability'], runtime: 'in-cluster',
    stars: 9300, forks: 3700, maturity: 'established', governance: 'community',
    github_topics: ['kubernetes', 'prometheus', 'monitoring', 'operator'],
    score: { popularity: 0.76, activity: 0.8, adoption: 0.79, quality: 0.83, quality_coverage: 0.9, total: 0.79, momentum: 0.35 },
  }),
  makeTool({
    repo: 'grafana/loki',
    description: 'Like Prometheus, but for logs',
    summary: 'Horizontally scalable log aggregation system indexed by labels rather than content.',
    kind: 'service', domains: ['observability'], runtime: 'in-cluster',
    stars: 23800, forks: 3500, maturity: 'established', governance: 'vendor-backed', openness: 'open-core',
    license: 'AGPL-3.0', license_class: 'copyleft',
    github_topics: ['kubernetes', 'logging', 'observability', 'grafana'],
    score: { popularity: 0.88, activity: 0.9, adoption: 0.75, quality: 0.8, quality_coverage: 0.9, total: 0.85, momentum: 0.55 },
  }),
  makeTool({
    repo: 'istio/istio',
    description: 'Connect, secure, control, and observe services',
    summary: 'Service mesh providing traffic management, mTLS and telemetry for service-to-service calls.',
    kind: 'controller', domains: ['service-mesh', 'networking', 'security'], runtime: 'in-cluster',
    stars: 36200, forks: 7900, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'service-mesh', 'istio', 'envoy'],
    score: { popularity: 0.93, activity: 0.88, adoption: 0.9, quality: 0.86, quality_coverage: 1, total: 0.9, momentum: 0.42 },
  }),
  makeTool({
    repo: 'open-policy-agent/gatekeeper',
    description: 'Policy Controller for Kubernetes',
    summary: 'Admission webhook enforcing OPA policies as constraints against cluster resources.',
    kind: 'admission-webhook', domains: ['policy', 'security'], runtime: 'in-cluster',
    stars: 3800, forks: 800, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'opa', 'policy', 'admission-controller'],
    score: { popularity: 0.62, activity: 0.72, adoption: 0.68, quality: 0.84, quality_coverage: 0.9, total: 0.7, momentum: 0.28 },
  }),
  makeTool({
    repo: 'kubernetes-sigs/kustomize',
    description: 'Customization of kubernetes YAML configurations',
    summary: 'Template-free customisation of Kubernetes manifests through overlays and patches.',
    kind: 'cli', domains: ['packaging', 'gitops'], runtime: 'workstation',
    stars: 11200, forks: 2300, maturity: 'established', governance: 'foundation',
    github_topics: ['kubernetes', 'kustomize', 'yaml', 'configuration'],
    install_methods: [
      { method: 'brew', command: 'brew install kustomize', source_url: 'https://formulae.brew.sh/formula/kustomize', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.78, activity: 0.65, adoption: 0.85, quality: 0.82, quality_coverage: 0.9, total: 0.78, momentum: 0.25 },
  }),
  makeTool({
    repo: 'fluxcd/flux2',
    description: 'Open and extensible continuous delivery solution for Kubernetes',
    summary: 'GitOps toolkit of controllers that reconcile cluster state from Git and OCI sources.',
    kind: 'cli', domains: ['gitops', 'ci-cd'], runtime: 'workstation',
    stars: 6800, forks: 640, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'gitops', 'flux', 'continuous-delivery'],
    install_methods: [
      { method: 'brew', command: 'brew install fluxcd/tap/flux', source_url: 'https://formulae.brew.sh/formula/flux', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.72, activity: 0.87, adoption: 0.7, quality: 0.88, quality_coverage: 1, total: 0.79, momentum: 0.5 },
  }),
  makeTool({
    repo: 'vmware-tanzu/velero',
    description: 'Backup and migrate Kubernetes applications and their persistent volumes',
    summary: 'Backs up cluster resources and persistent volumes, and restores them on demand.',
    kind: 'cli', domains: ['backup-dr', 'storage'], runtime: 'workstation',
    stars: 8900, forks: 1500, maturity: 'cncf-incubating', governance: 'vendor-backed',
    github_topics: ['kubernetes', 'backup', 'disaster-recovery', 'velero'],
    score: { popularity: 0.75, activity: 0.6, adoption: 0.66, quality: 0.79, quality_coverage: 0.9, total: 0.71, momentum: 0.22 },
  }),
  makeTool({
    repo: 'stern/stern',
    description: 'Multi pod and container log tailing for Kubernetes',
    summary: 'Tails logs from multiple pods and containers at once with colourised output.',
    kind: 'cli', domains: ['troubleshooting', 'observability'], runtime: 'workstation',
    stars: 4900, forks: 300, maturity: 'established', governance: 'community',
    github_topics: ['kubernetes', 'logs', 'cli', 'tail'],
    install_methods: [
      { method: 'brew', command: 'brew install stern', source_url: 'https://formulae.brew.sh/formula/stern', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.65, activity: 0.62, adoption: 0.55, quality: 0.72, quality_coverage: 0.6, total: 0.64, momentum: 0.3 },
  }),
  makeTool({
    repo: 'kubernetes-sigs/kind',
    description: 'Kubernetes IN Docker — local clusters for testing Kubernetes',
    summary: 'Runs local Kubernetes clusters using Docker containers as nodes, for testing and CI.',
    kind: 'cli', domains: ['testing', 'dev-experience'], runtime: 'workstation',
    stars: 13800, forks: 1600, maturity: 'established', governance: 'foundation',
    github_topics: ['kubernetes', 'docker', 'testing', 'kind'],
    install_methods: [
      { method: 'brew', command: 'brew install kind', source_url: 'https://formulae.brew.sh/formula/kind', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.81, activity: 0.75, adoption: 0.8, quality: 0.85, quality_coverage: 0.9, total: 0.81, momentum: 0.32 },
  }),
  makeTool({
    repo: 'k3s-io/k3s',
    description: 'Lightweight Kubernetes',
    summary: 'Single-binary Kubernetes distribution targeting edge, IoT and CI environments.',
    kind: 'distribution', domains: ['edge'], runtime: 'cluster-itself',
    stars: 28600, forks: 2400, maturity: 'cncf-sandbox', governance: 'vendor-backed',
    github_topics: ['kubernetes', 'k3s', 'edge', 'iot'],
    score: { popularity: 0.9, activity: 0.82, adoption: 0.77, quality: 0.8, quality_coverage: 0.9, total: 0.84, momentum: 0.48 },
  }),
  makeTool({
    repo: 'rancher/rancher',
    description: 'Complete container management platform',
    summary: 'Multi-cluster management platform with a web UI for provisioning and operations.',
    kind: 'dashboard-ui', domains: ['multi-cluster', 'dev-experience'], runtime: 'in-cluster',
    stars: 24100, forks: 3000, maturity: 'established', governance: 'vendor-backed', openness: 'open-core',
    github_topics: ['kubernetes', 'rancher', 'multi-cluster', 'management'],
    score: { popularity: 0.88, activity: 0.7, adoption: 0.72, quality: 0.7, quality_coverage: 0.75, total: 0.79, momentum: 0.2 },
  }),
  makeTool({
    repo: 'kedacore/keda',
    description: 'Kubernetes-based Event Driven Autoscaling',
    summary: 'Scales workloads from zero based on external event sources and queue depth.',
    kind: 'operator', domains: ['autoscaling'], runtime: 'in-cluster',
    stars: 9200, forks: 1200, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'autoscaling', 'keda', 'serverless'],
    score: { popularity: 0.76, activity: 0.83, adoption: 0.68, quality: 0.86, quality_coverage: 1, total: 0.78, momentum: 0.44 },
  }),
  makeTool({
    repo: 'kubernetes-sigs/cluster-api',
    description: 'Declarative Kubernetes-style APIs to cluster creation and management',
    summary: 'Provisions and manages the lifecycle of Kubernetes clusters through custom resources.',
    kind: 'controller', domains: ['multi-cluster'], runtime: 'in-cluster',
    stars: 3800, forks: 1400, maturity: 'established', governance: 'foundation',
    github_topics: ['kubernetes', 'cluster-api', 'lifecycle', 'provisioning'],
    score: { popularity: 0.6, activity: 0.85, adoption: 0.62, quality: 0.84, quality_coverage: 0.9, total: 0.71, momentum: 0.26 },
  }),
  makeTool({
    repo: 'traefik/traefik',
    description: 'The cloud native application proxy',
    summary: 'Reverse proxy and ingress controller that discovers services and routes traffic.',
    kind: 'controller', domains: ['networking'], runtime: 'in-cluster',
    stars: 51000, forks: 5100, maturity: 'cncf-incubating', governance: 'vendor-backed',
    github_topics: ['kubernetes', 'ingress', 'proxy', 'traefik'],
    score: { popularity: 0.96, activity: 0.78, adoption: 0.8, quality: 0.78, quality_coverage: 0.9, total: 0.87, momentum: 0.38 },
  }),
  makeTool({
    repo: 'kubernetes/dashboard',
    description: 'General-purpose web UI for Kubernetes clusters',
    summary: 'Web interface for browsing, inspecting and editing cluster workloads.',
    kind: 'dashboard-ui', domains: ['observability', 'dev-experience'], runtime: 'in-cluster',
    stars: 14700, forks: 4100, maturity: 'established', governance: 'foundation',
    github_topics: ['kubernetes', 'dashboard', 'ui', 'web'],
    score: { popularity: 0.83, activity: 0.55, adoption: 0.7, quality: 0.74, quality_coverage: 0.75, total: 0.73, momentum: 0.15 },
  }),
  makeTool({
    repo: 'tilt-dev/tilt',
    description: 'Define your dev environment as code for microservice apps',
    summary: 'Watches source, rebuilds images and live-updates running containers during development.',
    kind: 'cli', domains: ['dev-experience'], runtime: 'workstation',
    stars: 3900, forks: 340, maturity: 'established', governance: 'vendor-backed',
    github_topics: ['kubernetes', 'development', 'tilt', 'live-reload'],
    install_methods: [
      { method: 'brew', command: 'brew install tilt-dev/tap/tilt', source_url: 'https://formulae.brew.sh/formula/tilt', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.6, activity: 0.6, adoption: 0.5, quality: 0.72, quality_coverage: 0.75, total: 0.6, momentum: 0.2 },
  }),
  makeTool({
    repo: 'GoogleContainerTools/skaffold',
    description: 'Easy and repeatable Kubernetes development',
    summary: 'Automates the build, push and deploy loop for Kubernetes applications.',
    kind: 'cli', domains: ['dev-experience', 'ci-cd'], runtime: 'workstation',
    stars: 15100, forks: 1600, maturity: 'established', governance: 'vendor-backed',
    github_topics: ['kubernetes', 'development', 'ci-cd', 'skaffold'],
    install_methods: [
      { method: 'brew', command: 'brew install skaffold', source_url: 'https://formulae.brew.sh/formula/skaffold', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.84, activity: 0.6, adoption: 0.65, quality: 0.8, quality_coverage: 0.9, total: 0.74, momentum: 0.18 },
  }),
  makeTool({
    repo: 'crossplane/crossplane',
    description: 'The cloud native control plane framework',
    summary: 'Extends Kubernetes to provision and manage external cloud infrastructure as resources.',
    kind: 'controller', domains: ['multi-cluster', 'dev-experience'], runtime: 'in-cluster',
    stars: 9600, forks: 1000, maturity: 'cncf-graduated', governance: 'foundation',
    github_topics: ['kubernetes', 'crossplane', 'infrastructure', 'control-plane'],
    score: { popularity: 0.77, activity: 0.8, adoption: 0.6, quality: 0.85, quality_coverage: 1, total: 0.76, momentum: 0.4 },
  }),
  makeTool({
    repo: 'opencost/opencost',
    description: 'Cost monitoring for Kubernetes workloads',
    summary: 'Allocates cluster spend to namespaces, workloads and labels in real time.',
    kind: 'service', domains: ['cost', 'observability'], runtime: 'in-cluster',
    stars: 5200, forks: 420, maturity: 'cncf-incubating', governance: 'foundation',
    github_topics: ['kubernetes', 'cost', 'finops', 'monitoring'],
    score: { popularity: 0.66, activity: 0.74, adoption: 0.52, quality: 0.78, quality_coverage: 0.9, total: 0.68, momentum: 0.52 },
  }),
  makeTool({
    repo: 'aquasecurity/trivy',
    description: 'Find vulnerabilities, misconfigurations, secrets and SBOM',
    summary: 'Scans images, filesystems and Kubernetes manifests for vulnerabilities and misconfigurations.',
    kind: 'cli', domains: ['security'], runtime: 'ci-pipeline',
    stars: 24500, forks: 2400, maturity: 'established', governance: 'vendor-backed',
    github_topics: ['kubernetes', 'security', 'vulnerability-scanner', 'sbom'],
    install_methods: [
      { method: 'brew', command: 'brew install trivy', source_url: 'https://formulae.brew.sh/formula/trivy', verified_at: '2026-08-20T00:00:00.000Z' },
    ],
    score: { popularity: 0.89, activity: 0.93, adoption: 0.78, quality: 0.87, quality_coverage: 1, total: 0.87, momentum: 0.68 },
  }),
  makeTool({
    repo: 'kubernetes-sigs/descheduler',
    description: 'Descheduler for Kubernetes',
    summary: 'Evicts pods so the scheduler can replace them on better-suited nodes.',
    kind: 'controller', domains: ['scheduling'], runtime: 'in-cluster',
    stars: 4600, forks: 700, maturity: 'established', governance: 'foundation',
    github_topics: ['kubernetes', 'scheduler', 'descheduler', 'rebalancing'],
    score: { popularity: 0.63, activity: 0.66, adoption: 0.45, quality: 0.8, quality_coverage: 0.9, total: 0.63, momentum: 0.24 },
  }),

  // ── deliberate variety: the states the UI must handle ──────────────────────

  makeTool({
    repo: 'datreeio/datree',
    description: 'Prevent Kubernetes misconfigurations from reaching production (no longer maintained)',
    summary: 'Policy engine for Kubernetes manifests. The project is archived and no longer maintained.',
    kind: 'cli', domains: ['policy', 'testing'], runtime: 'ci-pipeline',
    stars: 6100, forks: 380, archived: true, maturity: 'archived', governance: 'vendor-backed',
    pushed_at: '2024-01-10T00:00:00.000Z',
    github_topics: ['kubernetes', 'policy', 'validation'],
    // §4.4: archived caps total at 0.4.
    score: { popularity: 0.68, activity: 0.05, adoption: 0.3, quality: 0.5, quality_coverage: 0.6, total: 0.4, momentum: 0.02 },
  }),
  makeTool({
    repo: 'etcd-io/etcd',
    description: 'Distributed reliable key-value store for the most critical data',
    summary: 'Consistent, highly available key-value store used as Kubernetes backing store.',
    kind: 'service', domains: ['database', 'storage'], runtime: 'cluster-itself',
    stars: 48200, forks: 9800, maturity: 'cncf-graduated',
    // §6: governance reports unknown for most real foundation projects until the CNCF
    // landscape seed ships. An org account alone proves nothing.
    governance: 'unknown',
    github_topics: ['kubernetes', 'etcd', 'key-value', 'raft'],
    score: { popularity: 0.95, activity: 0.72, adoption: 0.92, quality: 0.88, quality_coverage: 1, total: 0.88, momentum: 0.12 },
  }),
  makeTool({
    repo: 'dennyzhang/cheatsheet-kubernetes-A4',
    description: 'Kubernetes CheatSheets in A4',
    summary: 'A printable cheat sheet of common kubectl commands. Reference material, not a tool.',
    kind: 'learning-resource', domains: ['dev-experience'], runtime: 'unknown',
    stars: 6300, forks: 1400, language: null, license: null, license_class: 'unknown',
    openness: 'unknown', maturity: 'dormant', governance: 'individual',
    // §14: repos that merely mention Kubernetes are demoted, not deleted. 0.45 keeps it above
    // buildFilters' 0.4 floor, so the low-relevance path is visible in dev.
    k8s_relevance: 0.45, confidence: 0.55, needs_review: true,
    analysis_method: 'llm', analysis_model: 'claude-haiku-4-5-20251001',
    pushed_at: '2025-02-01T00:00:00.000Z',
    has_release: false,
    // §4.2: a repo OpenSSF never scanned has no score at all. Absence is unknown, not zero.
    signals: { scorecard: null, osv: null, dependents: null },
    github_topics: ['kubernetes', 'cheatsheet'],
    score: { popularity: 0.69, activity: 0.1, adoption: 0.05, quality: 0.3, quality_coverage: 0.25, total: 0.35, momentum: 0.04 },
  }),
];
```

- [ ] **Step 2: Typecheck it**

Run: `pnpm -F @keco/web check`
Expected: no errors. A taxonomy typo surfaces here only if it is a type error; Task 5's schema
test is what catches an invalid *value*.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/mocks/corpus/curated.ts
git commit -m "feat(web): add a curated mock corpus of real ecosystem projects"
```

---

### Task 4: The deterministic generator

Thirty documents never paginate. This pads the corpus so pagination, facet counts and the
momentum tail are exercised, without hand-maintaining hundreds of entries.

**Files:**
- Create: `apps/web/src/mocks/corpus/generate.ts`
- Test: `apps/web/src/mocks/corpus/generate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/mocks/corpus/generate.test.ts
import { ToolDocument, allValues } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { generateTools } from './generate';

describe('generateTools', () => {
  it('produces exactly the requested count', () => {
    expect(generateTools(50)).toHaveLength(50);
  });

  it('is deterministic — same seed, byte-identical output', () => {
    expect(JSON.stringify(generateTools(20))).toBe(JSON.stringify(generateTools(20)));
  });

  it('produces unique ids', () => {
    const tools = generateTools(200);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(200);
  });

  it('produces documents that satisfy the read model schema', () => {
    for (const tool of generateTools(100)) {
      expect(() => ToolDocument.parse(tool)).not.toThrow();
    }
  });

  it('draws values from the taxonomy file, so every kind gets represented at volume', () => {
    const kinds = new Set(generateTools(300).map((tool) => tool.kind));
    for (const value of allValues('kind')) {
      expect(kinds.has(value.id)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/mocks/corpus/generate.test.ts`
Expected: FAIL — `Failed to resolve import "./generate"`

- [ ] **Step 3: Write the generator**

`allValues()` reads the taxonomy file, so a new family value is populated automatically rather
than needing an edit here.

```ts
// apps/web/src/mocks/corpus/generate.ts
import { allValues, type ToolDocument } from '@keco/core';
import { makeTool } from './builder';

/**
 * Mock fixture data — development and test only.
 *
 * Deterministic: same input, byte-identical output, in every checkout. A diff in rendered
 * output therefore means someone changed this generator, not that fixtures drifted.
 */

/** mulberry32 — a small seeded PRNG. Written inline rather than adding a dependency. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (familyId: string): string[] => allValues(familyId).map((value) => value.id);

const ADJECTIVES = ['swift', 'quiet', 'atomic', 'nimble', 'stable', 'lucid', 'brisk', 'solid'];
const NOUNS = ['harbor', 'anchor', 'beacon', 'compass', 'lantern', 'pylon', 'rudder', 'mast'];
const ORGS = ['mockcorp', 'fixture-labs', 'devseed', 'sample-io', 'stubworks'];
const LANGUAGES = ['Go', 'Rust', 'TypeScript', 'Python', 'Java', null];

export function generateTools(count: number, seed = 20260823): ToolDocument[] {
  const random = rng(seed);
  const pick = <T,>(list: readonly T[], fallback: T): T => list[Math.floor(random() * list.length)] ?? fallback;

  const kinds = ids('kind');
  const domains = ids('domains');
  const runtimes = ids('runtime');
  const licenseClasses = ids('license_class');
  const opennesses = ids('openness');
  const maturities = ids('maturity');
  const governances = ids('governance');

  return Array.from({ length: count }, (_, index) => {
    // Index-driven rather than random, so every taxonomy value is represented at volume and
    // the test above cannot flake on an unlucky seed.
    const kind = kinds[index % kinds.length] ?? 'service';
    const adjective = pick(ADJECTIVES, 'swift');
    const noun = pick(NOUNS, 'harbor');
    const name = `${adjective}-${noun}-${index}`;
    const owner = pick(ORGS, 'mockcorp');

    const domainCount = 1 + Math.floor(random() * 3);
    const chosen = new Set<string>();
    while (chosen.size < domainCount) {
      chosen.add(domains[Math.floor(random() * domains.length)] ?? 'dev-experience');
    }

    const stars = Math.floor(random() * 12000);
    const archived = random() < 0.06;
    const hasScorecard = random() < 0.55;
    const total = archived ? Math.min(0.4, random()) : random();

    return makeTool({
      repo: `${owner}/${name}`,
      description: `A generated ${kind} fixture for Kubernetes ${[...chosen].join(' and ')}.`,
      summary: `${name} is a generated mock ${kind} covering ${[...chosen].join(', ')}.`,
      kind,
      domains: [...chosen],
      runtime: runtimes[index % runtimes.length] ?? 'unknown',
      license_class: licenseClasses[index % licenseClasses.length] ?? 'unknown',
      openness: opennesses[index % opennesses.length] ?? 'unknown',
      maturity: archived ? 'archived' : (maturities[index % maturities.length] ?? 'unknown'),
      governance: governances[index % governances.length] ?? 'unknown',
      stars,
      forks: Math.floor(stars / 8),
      open_issues: Math.floor(random() * 300),
      language: pick(LANGUAGES, 'Go'),
      archived,
      k8s_relevance: 0.4 + random() * 0.6,
      confidence: 0.5 + random() * 0.5,
      has_release: random() < 0.7,
      signals: hasScorecard
        ? { scorecard: { score: Number((random() * 10).toFixed(1)), checks: { Maintained: 5 }, fetched_at: '2026-08-20T00:00:00.000Z' }, osv: { open_vulns: 0, fetched_at: '2026-08-20T00:00:00.000Z' }, dependents: Math.floor(random() * 500) }
        : { scorecard: null, osv: null, dependents: null },
      pushed_at: new Date(Date.UTC(2026, index % 12, 1 + (index % 27))).toISOString(),
      created_at: new Date(Date.UTC(2018 + (index % 7), index % 12, 1 + (index % 27))).toISOString(),
      readme_excerpt: `# ${name}\n\nGenerated fixture. Not a real project.`,
      score: {
        popularity: random(),
        activity: archived ? random() * 0.2 : random(),
        adoption: random(),
        quality: random(),
        quality_coverage: hasScorecard ? 0.9 : 0.4,
        total,
        momentum: archived ? random() * 0.05 : random(),
      },
    });
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/web/src/mocks/corpus/generate.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/mocks/corpus/generate.ts apps/web/src/mocks/corpus/generate.test.ts
git commit -m "feat(web): add a deterministic mock corpus generator"
```

---

### Task 5: Assemble the corpus, with the build sentinel

**Files:**
- Create: `apps/web/src/mocks/corpus/index.ts`
- Test: `apps/web/src/mocks/corpus/corpus.test.ts`

- [ ] **Step 1: Write the failing test**

This is the schema drift guard: change the read model and the fixtures fail immediately instead
of rendering something impossible.

```ts
// apps/web/src/mocks/corpus/corpus.test.ts
import { ToolDocument } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { MOCK_CORPUS, MOCK_SENTINEL } from './index';

describe('the mock corpus', () => {
  it('is large enough to paginate', () => {
    expect(MOCK_CORPUS.length).toBeGreaterThan(250);
  });

  it('has a document for every curated and generated entry, with unique ids', () => {
    expect(new Set(MOCK_CORPUS.map((tool) => tool.id)).size).toBe(MOCK_CORPUS.length);
  });

  it('validates every document against the read model schema', () => {
    for (const tool of MOCK_CORPUS) {
      const result = ToolDocument.safeParse(tool);
      if (!result.success) {
        throw new Error(`${tool.full_name} is not a valid ToolDocument: ${result.error.message}`);
      }
    }
  });

  it('covers the states the UI has to handle', () => {
    expect(MOCK_CORPUS.some((tool) => tool.archived)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.needs_review)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.signals.scorecard === null)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.install_methods.length === 0)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.install_methods.length > 1)).toBe(true);
    expect(MOCK_CORPUS.some((tool) => tool.governance === 'unknown')).toBe(true);
  });

  it('exposes a distinctive sentinel for the production-build scan', () => {
    expect(MOCK_SENTINEL).toBe('KECO_MOCK_CORPUS_DO_NOT_SHIP');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/mocks/corpus/corpus.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`

- [ ] **Step 3: Write the assembly**

```ts
// apps/web/src/mocks/corpus/index.ts
import type { ToolDocument } from '@keco/core';
import { CURATED } from './curated';
import { generateTools } from './generate';

/**
 * Mock fixture data — development and test only. See the governing invariant in
 * docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md: this must never reach a
 * production build, and `apps/web/scripts/assert-no-mocks.ts` verifies that it does not.
 */

/**
 * A distinctive string that exists nowhere else in the codebase, so scanning a built `dist/`
 * for it is a reliable signal. Deliberately not something short like "msw", which occurs by
 * chance in minified output — a guard that false-positives is a guard someone switches off.
 */
export const MOCK_SENTINEL = 'KECO_MOCK_CORPUS_DO_NOT_SHIP';

const TARGET_SIZE = 300;

export const MOCK_CORPUS: ToolDocument[] = [
  ...CURATED,
  ...generateTools(Math.max(0, TARGET_SIZE - CURATED.length)),
];
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/web/src/mocks/corpus/corpus.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/mocks/corpus/index.ts apps/web/src/mocks/corpus/corpus.test.ts
git commit -m "feat(web): assemble the mock corpus with a schema drift guard"
```

---

### Task 6: The query engine — filters

The riskiest module, so it is built in three tested slices. This one implements the three
filter forms `buildFilters()` can emit.

**Files:**
- Create: `apps/web/src/mocks/engine.ts`
- Test: `apps/web/src/mocks/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/mocks/engine.test.ts
import { buildFilters } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { makeTool } from './corpus/builder';
import { runSearch } from './engine';

const corpus = [
  makeTool({ repo: 'a/cli-tool', kind: 'cli', domains: ['security'], stars: 100, k8s_relevance: 0.9 }),
  makeTool({ repo: 'b/an-operator', kind: 'operator', domains: ['storage'], stars: 500, k8s_relevance: 0.9 }),
  makeTool({ repo: 'c/archived-cli', kind: 'cli', domains: ['security'], stars: 900, archived: true, k8s_relevance: 0.9 }),
  makeTool({ repo: 'd/low-relevance', kind: 'cli', domains: ['security'], stars: 700, k8s_relevance: 0.2 }),
  makeTool({
    repo: 'e/brewable', kind: 'cli', domains: ['policy'], stars: 300, k8s_relevance: 0.9,
    install_methods: [{ method: 'brew', command: 'brew install brewable', source_url: 'https://formulae.brew.sh/formula/brewable', verified_at: '2026-08-20T00:00:00.000Z' }],
  }),
];

const names = (hits: { full_name: string }[]) => hits.map((hit) => hit.full_name).sort();

describe('runSearch filters', () => {
  it('applies the default filters buildFilters always emits: not archived, relevance floor', () => {
    const result = runSearch(corpus, { filter: buildFilters({}) });
    expect(names(result.hits)).toEqual(['a/cli-tool', 'b/an-operator', 'e/brewable']);
  });

  it('includes archived documents when the filter permits it', () => {
    const result = runSearch(corpus, { filter: buildFilters({ includeArchived: true }) });
    expect(names(result.hits)).toContain('c/archived-cli');
  });

  it('honours the relevance floor as a number comparison, not a string one', () => {
    const result = runSearch(corpus, { filter: buildFilters({ includeArchived: true, minRelevance: 0.1 }) });
    expect(names(result.hits)).toContain('d/low-relevance');
  });

  it('applies an IN clause on a taxonomy family', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { kind: ['operator'] } }) });
    expect(names(result.hits)).toEqual(['b/an-operator']);
  });

  it('treats multiple values in one IN clause as OR', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { kind: ['cli', 'operator'] } }) });
    expect(names(result.hits)).toEqual(['a/cli-tool', 'b/an-operator', 'e/brewable']);
  });

  it('treats separate clauses as AND', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { kind: ['cli'], domains: ['policy'] } }) });
    expect(names(result.hits)).toEqual(['e/brewable']);
  });

  it('matches an array-of-objects attribute through install_methods.method', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { install_methods: ['brew'] } }) });
    expect(names(result.hits)).toEqual(['e/brewable']);
  });

  it('matches a document whose array attribute contains the value', () => {
    const result = runSearch(corpus, { filter: buildFilters({ filters: { domains: ['security'] } }) });
    expect(names(result.hits)).toEqual(['a/cli-tool']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/mocks/engine.test.ts`
Expected: FAIL — `Failed to resolve import "./engine"`

- [ ] **Step 3: Write the engine's filter half**

```ts
// apps/web/src/mocks/engine.ts
import { MAX_TOTAL_HITS, type ToolDocument } from '@keco/core';

/**
 * Mock query engine — development and test only.
 *
 * An evaluator for the finite grammar `buildFilters()` and `sortSpec()` can emit, not a
 * general Meilisearch implementation. It approximates relevance and must never be used to
 * judge ranking, tune searchableAttributes weights, or validate a filter before production.
 */

export type MockSearchRequest = {
  q?: string;
  filter?: string[];
  sort?: string[];
  page?: number;
  hitsPerPage?: number;
  facets?: string[];
};

export type MockSearchResponse = {
  hits: ToolDocument[];
  query: string;
  page: number;
  hitsPerPage: number;
  totalHits: number;
  totalPages: number;
  processingTimeMs: number;
  facetDistribution: Record<string, Record<string, number>>;
};

/**
 * Resolves a dotted attribute path to the values it can match. Returns an array because
 * `domains` is a list and `install_methods.method` is a projection over a list of objects —
 * a document matches if any resolved value matches.
 */
export function valuesAt(tool: ToolDocument, path: string): unknown[] {
  let current: unknown[] = [tool];
  for (const segment of path.split('.')) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item !== null && typeof item === 'object') {
            next.push((item as Record<string, unknown>)[segment]);
          }
        }
        continue;
      }
      if (typeof node === 'object') next.push((node as Record<string, unknown>)[segment]);
    }
    current = next.flatMap((value) => (Array.isArray(value) ? value : [value]));
  }
  return current.filter((value) => value !== undefined);
}

const IN_CLAUSE = /^(?<attribute>[\w.]+)\s+IN\s+\[(?<values>.*)\]$/;
const COMPARISON = /^(?<attribute>[\w.]+)\s*(?<operator>>=|<=|=|>|<)\s*(?<literal>.+)$/;

const parseLiteral = (raw: string): string | number | boolean => {
  const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const asNumber = Number(trimmed);
  return trimmed !== '' && !Number.isNaN(asNumber) ? asNumber : trimmed;
};

function matchesClause(tool: ToolDocument, clause: string): boolean {
  const inMatch = IN_CLAUSE.exec(clause.trim());
  if (inMatch?.groups) {
    const wanted = (inMatch.groups.values ?? '')
      .split(',')
      .map((value) => String(parseLiteral(value)))
      .filter((value) => value !== '');
    const actual = valuesAt(tool, inMatch.groups.attribute ?? '').map(String);
    return actual.some((value) => wanted.includes(value));
  }

  const comparison = COMPARISON.exec(clause.trim());
  if (comparison?.groups) {
    const expected = parseLiteral(comparison.groups.literal ?? '');
    const actual = valuesAt(tool, comparison.groups.attribute ?? '');
    return actual.some((value) => {
      switch (comparison.groups?.operator) {
        case '=': return value === expected;
        case '>=': return Number(value) >= Number(expected);
        case '<=': return Number(value) <= Number(expected);
        case '>': return Number(value) > Number(expected);
        case '<': return Number(value) < Number(expected);
        default: return false;
      }
    });
  }

  // An unrecognised clause means the portal emits something this engine does not model.
  // Failing loudly is the whole point — a silently ignored filter shows wrong results.
  throw new Error(`mock engine: unsupported filter clause ${JSON.stringify(clause)}`);
}

/** Every clause must hold: buildFilters() returns an array, and Meilisearch ANDs it. */
const matchesFilters = (tool: ToolDocument, filters: string[]): boolean =>
  filters.every((clause) => matchesClause(tool, clause));

export function runSearch(corpus: ToolDocument[], request: MockSearchRequest): MockSearchResponse {
  const matched = corpus.filter((tool) => matchesFilters(tool, request.filter ?? []));
  const hitsPerPage = request.hitsPerPage ?? 20;
  const page = request.page ?? 1;
  const totalHits = Math.min(matched.length, MAX_TOTAL_HITS);

  return {
    hits: hitsPerPage === 0 ? [] : matched.slice((page - 1) * hitsPerPage, page * hitsPerPage),
    query: request.q ?? '',
    page,
    hitsPerPage,
    totalHits,
    totalPages: hitsPerPage === 0 ? 0 : Math.ceil(totalHits / hitsPerPage),
    processingTimeMs: 1,
    facetDistribution: {},
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run apps/web/src/mocks/engine.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/mocks/engine.ts apps/web/src/mocks/engine.test.ts
git commit -m "feat(web): implement the mock engine's filter evaluation"
```

---

### Task 7: The query engine — matching, sorting, pagination

**Files:**
- Modify: `apps/web/src/mocks/engine.ts`
- Modify: `apps/web/src/mocks/engine.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `apps/web/src/mocks/engine.test.ts`:

```ts
describe('runSearch matching, sorting and pagination', () => {
  const searchable = [
    // `name` is derived from `repo`, so it is not an override ToolOverrides accepts.
    makeTool({ repo: 'x/kubectx', summary: 'switch contexts', k8s_relevance: 0.9 }),
    makeTool({ repo: 'y/other', summary: 'a tool that mentions kubectx in its summary', k8s_relevance: 0.9 }),
    makeTool({ repo: 'z/unrelated', summary: 'nothing to see', k8s_relevance: 0.9 }),
  ];

  it('matches an empty query against everything', () => {
    expect(runSearch(searchable, { q: '' }).hits).toHaveLength(3);
  });

  it('matches case-insensitively across searchable fields', () => {
    expect(names(runSearch(searchable, { q: 'KUBECTX' }).hits)).toEqual(['x/kubectx', 'y/other']);
  });

  it('ranks a name match above a summary-only match', () => {
    const hits = runSearch(searchable, { q: 'kubectx' }).hits;
    expect(hits[0]?.full_name).toBe('x/kubectx');
  });

  it('returns nothing for a query that matches nothing', () => {
    const result = runSearch(searchable, { q: 'zzzzz-no-such-tool' });
    expect(result.hits).toEqual([]);
    expect(result.totalHits).toBe(0);
  });

  it('sorts by each spec sortSpec() can emit', () => {
    const sortable = [
      makeTool({ repo: 'a/one', stars: 10, pushed_at: '2020-01-01T00:00:00.000Z', score: { popularity: 0, activity: 0, adoption: 0, quality: 0, quality_coverage: 1, total: 0.1, momentum: 0.9 } }),
      makeTool({ repo: 'b/two', stars: 90, pushed_at: '2026-01-01T00:00:00.000Z', score: { popularity: 0, activity: 0, adoption: 0, quality: 0, quality_coverage: 1, total: 0.9, momentum: 0.1 } }),
    ];
    expect(runSearch(sortable, { sort: ['stars:desc'] }).hits[0]?.full_name).toBe('b/two');
    expect(runSearch(sortable, { sort: ['score.total:desc'] }).hits[0]?.full_name).toBe('b/two');
    expect(runSearch(sortable, { sort: ['score.momentum:desc'] }).hits[0]?.full_name).toBe('a/one');
    expect(runSearch(sortable, { sort: ['pushed_at:desc'] }).hits[0]?.full_name).toBe('b/two');
  });

  it('paginates, and reports totals over the whole match set', () => {
    const many = Array.from({ length: 45 }, (_, i) => makeTool({ repo: `org/tool-${i}`, k8s_relevance: 0.9 }));
    const second = runSearch(many, { page: 2, hitsPerPage: 20 });
    expect(second.hits).toHaveLength(20);
    expect(second.page).toBe(2);
    expect(second.totalHits).toBe(45);
    expect(second.totalPages).toBe(3);
    expect(runSearch(many, { page: 3, hitsPerPage: 20 }).hits).toHaveLength(5);
  });

  it('returns counts but no hits when hitsPerPage is 0, as browseFacets() requires', () => {
    const many = Array.from({ length: 10 }, (_, i) => makeTool({ repo: `org/t-${i}`, k8s_relevance: 0.9 }));
    const result = runSearch(many, { hitsPerPage: 0 });
    expect(result.hits).toEqual([]);
    expect(result.totalHits).toBe(10);
  });
});
```

- [ ] **Step 2: Run and confirm the new tests fail**

Run: `pnpm vitest run apps/web/src/mocks/engine.test.ts`
Expected: FAIL — the query is ignored, so `q: 'KUBECTX'` returns all 3 and sorting is a no-op.

- [ ] **Step 3: Add matching and sorting to the engine**

Insert above `runSearch` in `apps/web/src/mocks/engine.ts`:

```ts
/**
 * `tools`' searchableAttributes in weight order (§5). A lower index is a better match. This
 * approximates Meilisearch's relevance; it does not reproduce it.
 */
const SEARCHABLE = ['name', 'full_name', 'summary', 'description', 'github_topics', 'readme_excerpt'] as const;

/** Best (lowest) field index the query matches, or null when nothing matches. */
function matchRank(tool: ToolDocument, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return SEARCHABLE.length;

  for (const [index, attribute] of SEARCHABLE.entries()) {
    const haystack = valuesAt(tool, attribute)
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (haystack.includes(needle)) return index;
  }
  return null;
}

const compareBy = (spec: string) => (a: ToolDocument, b: ToolDocument): number => {
  const [attribute = '', direction = 'asc'] = spec.split(':');
  const [left] = valuesAt(a, attribute);
  const [right] = valuesAt(b, attribute);
  const order =
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left ?? '').localeCompare(String(right ?? ''));
  return direction === 'desc' ? -order : order;
};
```

Then replace the body of `runSearch` with:

```ts
export function runSearch(corpus: ToolDocument[], request: MockSearchRequest): MockSearchResponse {
  const query = request.q ?? '';

  const ranked: { tool: ToolDocument; rank: number }[] = [];
  for (const tool of corpus) {
    if (!matchesFilters(tool, request.filter ?? [])) continue;
    const rank = matchRank(tool, query);
    if (rank === null) continue;
    ranked.push({ tool, rank });
  }

  const sorts = request.sort ?? [];
  if (sorts.length > 0) {
    for (const spec of [...sorts].reverse()) ranked.sort((a, b) => compareBy(spec)(a.tool, b.tool));
  } else {
    // No sort: match quality first, then score.total — the index's tie-breaker (§5).
    ranked.sort((a, b) => a.rank - b.rank || b.tool.score.total - a.tool.score.total);
  }

  const matched = ranked.map((entry) => entry.tool);
  const hitsPerPage = request.hitsPerPage ?? 20;
  const page = request.page ?? 1;
  const totalHits = Math.min(matched.length, MAX_TOTAL_HITS);

  return {
    hits: hitsPerPage === 0 ? [] : matched.slice((page - 1) * hitsPerPage, page * hitsPerPage),
    query,
    page,
    hitsPerPage,
    totalHits,
    totalPages: hitsPerPage === 0 ? 0 : Math.ceil(totalHits / hitsPerPage),
    processingTimeMs: 1,
    facetDistribution: facetDistribution(matched, request.facets ?? []),
  };
}
```

`facetDistribution` does not exist yet — add a temporary stub directly above `runSearch` so
this task's tests can run; Task 8 replaces it:

```ts
const facetDistribution = (_tools: ToolDocument[], _facets: string[]): Record<string, Record<string, number>> => ({});
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/mocks/engine.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/mocks/engine.ts apps/web/src/mocks/engine.test.ts
git commit -m "feat(web): add matching, sorting and pagination to the mock engine"
```

---

### Task 8: The query engine — facet distribution

Facet distribution is the only aggregation this system has (§5), and it drives the entire home
page. Meilisearch computes it over the **filtered** set.

**Files:**
- Modify: `apps/web/src/mocks/engine.ts`
- Modify: `apps/web/src/mocks/engine.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `apps/web/src/mocks/engine.test.ts`:

```ts
describe('runSearch facet distribution', () => {
  const faceted = [
    makeTool({ repo: 'a/one', kind: 'cli', domains: ['security', 'policy'], k8s_relevance: 0.9 }),
    makeTool({ repo: 'b/two', kind: 'cli', domains: ['security'], k8s_relevance: 0.9 }),
    makeTool({ repo: 'c/three', kind: 'operator', domains: ['storage'], k8s_relevance: 0.9 }),
    makeTool({
      repo: 'd/four', kind: 'cli', domains: ['storage'], k8s_relevance: 0.9,
      install_methods: [{ method: 'krew', command: 'kubectl krew install four', source_url: 'https://krew.sigs.k8s.io/plugins/', verified_at: '2026-08-20T00:00:00.000Z' }],
    }),
  ];

  it('counts documents per value for a scalar attribute', () => {
    const result = runSearch(faceted, { facets: ['kind'] });
    expect(result.facetDistribution.kind).toEqual({ cli: 3, operator: 1 });
  });

  it('counts each value of a list attribute once per document', () => {
    const result = runSearch(faceted, { facets: ['domains'] });
    expect(result.facetDistribution.domains).toEqual({ security: 2, policy: 1, storage: 2 });
  });

  it('counts a projected attribute through an array of objects', () => {
    const result = runSearch(faceted, { facets: ['install_methods.method'] });
    expect(result.facetDistribution['install_methods.method']).toEqual({ krew: 1 });
  });

  it('counts over the filtered set, not the whole corpus', () => {
    const result = runSearch(faceted, { filter: ['kind IN ["operator"]'], facets: ['domains'] });
    expect(result.facetDistribution.domains).toEqual({ storage: 1 });
  });

  it('omits nothing and invents nothing when no facets are requested', () => {
    expect(runSearch(faceted, {}).facetDistribution).toEqual({});
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm vitest run apps/web/src/mocks/engine.test.ts`
Expected: FAIL — the stub returns `{}` for every request.

- [ ] **Step 3: Replace the stub with the real implementation**

Replace the one-line `facetDistribution` stub in `apps/web/src/mocks/engine.ts` with:

```ts
/**
 * Counts documents per value for each requested attribute, over the filtered set — matching
 * Meilisearch's facetDistribution semantics (§5). A value with zero documents is absent,
 * which is what lets the home page render no chip rather than a dead one (§9).
 */
function facetDistribution(
  tools: ToolDocument[],
  facets: string[],
): Record<string, Record<string, number>> {
  const distribution: Record<string, Record<string, number>> = {};

  for (const attribute of facets) {
    const counts: Record<string, number> = {};
    for (const tool of tools) {
      // A Set so a document with the same value twice still counts once.
      for (const value of new Set(valuesAt(tool, attribute).map(String))) {
        counts[value] = (counts[value] ?? 0) + 1;
      }
    }
    distribution[attribute] = counts;
  }

  return distribution;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/mocks/engine.test.ts`
Expected: PASS, 20 tests

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/mocks/engine.ts apps/web/src/mocks/engine.test.ts
git commit -m "feat(web): compute facet distribution in the mock engine"
```

---

### Task 9: The pinning test

Adding a taxonomy family must fail a test rather than silently produce an unfacetable filter,
in the same spirit as `packages/analyze/src/rules/pinning.test.ts`.

**Files:**
- Create: `apps/web/src/mocks/engine.pinning.test.ts`

- [ ] **Step 1: Write the test**

```ts
// apps/web/src/mocks/engine.pinning.test.ts
import { allValues, buildFilters, defaultFacets, facetableFamilies, familyAttribute, sortSpec } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { MOCK_CORPUS } from './corpus/index';
import { runSearch, valuesAt } from './engine';

/**
 * The mock engine must handle everything the shared read-side algebra can emit. This test is
 * driven by taxonomy.yaml and by SortKey, so adding a family or a sort fails here rather than
 * producing wrong results in dev.
 */
const SORT_KEYS = ['relevance', 'stars', 'score', 'momentum', 'recent'] as const;

describe('the mock engine covers the whole read-side algebra', () => {
  it('resolves every attribute defaultFacets() can name', () => {
    for (const attribute of defaultFacets()) {
      const resolvable = MOCK_CORPUS.some((tool) => valuesAt(tool, attribute).length > 0);
      expect(resolvable, `no document resolves ${attribute}`).toBe(true);
    }
  });

  it('produces a non-empty facet distribution for every facetable family', () => {
    const result = runSearch(MOCK_CORPUS, { facets: defaultFacets() });
    for (const familyId of facetableFamilies()) {
      const attribute = familyAttribute(familyId);
      expect(Object.keys(result.facetDistribution[attribute] ?? {}).length, `${attribute} has no counts`).toBeGreaterThan(0);
    }
  });

  it('evaluates an IN filter for every facetable family without throwing', () => {
    for (const familyId of facetableFamilies()) {
      const first = allValues(familyId)[0];
      expect(first, `${familyId} declares no values`).toBeDefined();
      const filter = buildFilters({ filters: { [familyId]: [first?.id ?? ''] } });
      expect(() => runSearch(MOCK_CORPUS, { filter })).not.toThrow();
    }
  });

  it('accepts every spec sortSpec() can emit', () => {
    for (const key of SORT_KEYS) {
      const sort = sortSpec(key);
      const result = runSearch(MOCK_CORPUS, { sort, hitsPerPage: 5 });
      expect(result.hits.length, `sort=${key} returned nothing`).toBeGreaterThan(0);
    }
  });

  it('rejects a filter clause it does not model, rather than ignoring it', () => {
    expect(() => runSearch(MOCK_CORPUS, { filter: ['stars TO 500'] })).toThrow(/unsupported filter clause/);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes**

Run: `pnpm vitest run apps/web/src/mocks/engine.pinning.test.ts`
Expected: PASS, 5 tests

If "no document resolves X" fails, the generator in Task 4 is not populating that family —
fix `generateTools`, not this test.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/mocks/engine.pinning.test.ts
git commit -m "test(web): pin the mock engine to the read-side algebra"
```

---

### Task 10: README fixtures and MSW handlers

**Files:**
- Create: `apps/web/src/mocks/readmes.ts`
- Create: `apps/web/src/mocks/handlers.ts`
- Test: `apps/web/src/mocks/handlers.test.ts`

- [ ] **Step 1: Write the failing test**

`handlers.ts` must import from isomorphic `msw` only — never `msw/browser` — so it can be
exercised in the node test environment through `setupServer`. That constraint is what makes
this test possible; keep it.

```ts
// apps/web/src/mocks/handlers.test.ts
import { toDocumentId } from '@keco/core';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from './handlers';

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const search = async (body: Record<string, unknown>) => {
  const response = await fetch('http://localhost:7700/indexes/tools/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

describe('mock handlers', () => {
  it('answers a search with a Meilisearch-shaped response', async () => {
    const { status, body } = await search({ q: '', hitsPerPage: 5, facets: ['kind'] });
    expect(status).toBe(200);
    expect(body.hits).toHaveLength(5);
    expect(body.totalHits).toBeGreaterThan(5);
    expect(body.page).toBe(1);
    expect(Object.keys(body.facetDistribution.kind).length).toBeGreaterThan(0);
    expect(typeof body.processingTimeMs).toBe('number');
  });

  it('answers regardless of which host VITE_MEILI_HOST points at', async () => {
    const response = await fetch('https://meili.example.com/indexes/tools/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '' }),
    });
    expect(response.status).toBe(200);
  });

  it('returns a single document by id', async () => {
    const id = toDocumentId('derailed/k9s');
    const response = await fetch(`http://localhost:7700/indexes/tools/documents/${id}`);
    expect(response.status).toBe(200);
    expect((await response.json()).full_name).toBe('derailed/k9s');
  });

  it('404s an unknown document, so getTool() resolves to null', async () => {
    const response = await fetch('http://localhost:7700/indexes/tools/documents/no__such');
    expect(response.status).toBe(404);
  });

  it('serves a README in the shape apps/api returns', async () => {
    const response = await fetch('http://localhost:7700/api/readme/derailed/k9s');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.repo).toBe('derailed/k9s');
    expect(body.html).toContain('<');
    expect(body.truncated).toBe(false);
  });

  it('404s a README that was never cached — an ordinary pre-crawl state', async () => {
    const response = await fetch('http://localhost:7700/api/readme/mockcorp/nothing-here');
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/src/mocks/handlers.test.ts`
Expected: FAIL — `Failed to resolve import "./handlers"`

- [ ] **Step 3: Write the README fixtures**

Pre-sanitised HTML, not markdown: §9 and §14 forbid rendering untrusted README markdown in the
browser, and the real route returns HTML that has already been through rehype-sanitize and
Shiki. Storing HTML matches the contract and keeps the markdown pipeline out of the dev bundle.

```ts
// apps/web/src/mocks/readmes.ts
/**
 * Mock README fixtures — development and test only.
 *
 * Already-safe HTML, matching what apps/api returns after rehype-sanitize and Shiki. Never
 * markdown: rendering untrusted README markdown in the browser is a stored-XSS hole across
 * the whole corpus (§9, §14), and a fixture must not be a worked example of it.
 *
 * Only curated repos have an entry. A generated repo has none on purpose — a missing README is
 * an ordinary state before the crawler reaches a repo, the tool page already handles it, and
 * dev should exercise that path regularly.
 */
export type MockReadme = { html: string; truncated: boolean };

const page = (title: string, blurb: string, install: string): MockReadme => ({
  html: [
    `<h1>${title}</h1>`,
    `<p>${blurb}</p>`,
    '<h2>Installation</h2>',
    `<pre><code>${install}</code></pre>`,
    '<h2>Usage</h2>',
    '<p>This is mock README content served by the development mock backend. It is not the real project documentation.</p>',
    '<h2>License</h2>',
    '<p>See the upstream repository for licensing.</p>',
  ].join('\n'),
  truncated: false,
});

export const MOCK_READMES: Record<string, MockReadme> = {
  'argoproj/argo-cd': page('Argo CD', 'Declarative GitOps continuous delivery for Kubernetes.', 'kubectl apply -n argocd -f install.yaml'),
  'cilium/cilium': page('Cilium', 'eBPF-based networking, observability and security.', 'helm install cilium cilium/cilium'),
  'derailed/k9s': page('K9s', 'Kubernetes CLI to manage your clusters in style.', 'brew install k9s'),
  'helm/helm': page('Helm', 'The Kubernetes package manager.', 'brew install helm'),
  'cert-manager/cert-manager': page('cert-manager', 'Automatically provision and manage TLS certificates.', 'helm install cert-manager jetstack/cert-manager'),
  'ahmetb/kubectx': page('kubectx + kubens', 'Faster way to switch between clusters and namespaces.', 'brew install kubectx'),
  'aquasecurity/trivy': page('Trivy', 'Find vulnerabilities, misconfigurations, secrets and SBOM.', 'brew install trivy'),
  'kubernetes-sigs/kind': page('kind', 'Kubernetes IN Docker — local clusters for testing.', 'brew install kind'),
};
```

- [ ] **Step 4: Write the handlers**

```ts
// apps/web/src/mocks/handlers.ts
import { TOOLS_INDEX } from '@keco/core';
import { http, HttpResponse } from 'msw';
import { MOCK_CORPUS } from './corpus/index';
import { runSearch, type MockSearchRequest } from './engine';
import { MOCK_READMES } from './readmes';

/**
 * Mock request handlers — development and test only.
 *
 * Imports isomorphic `msw` only, never `msw/browser`: that keeps this module loadable in the
 * node test environment through setupServer, which is how handlers.test.ts covers the URL
 * patterns as well as the responses. `browser.ts` owns the browser-only import.
 *
 * Patterns are host-wildcarded (`*/...`) so interception works whatever VITE_MEILI_HOST is
 * set to, without this module reading Vite's env.
 */
export const handlers = [
  http.post(`*/indexes/${TOOLS_INDEX}/search`, async ({ request }) => {
    const body = (await request.json()) as MockSearchRequest;
    return HttpResponse.json(runSearch(MOCK_CORPUS, body));
  }),

  http.get(`*/indexes/${TOOLS_INDEX}/documents/:id`, ({ params }) => {
    const tool = MOCK_CORPUS.find((candidate) => candidate.id === params.id);
    if (!tool) {
      // The shape meilisearch-js turns into a MeilisearchApiError, which getTool() catches.
      return HttpResponse.json(
        { message: `Document \`${String(params.id)}\` not found.`, code: 'document_not_found', type: 'invalid_request', link: '' },
        { status: 404 },
      );
    }
    return HttpResponse.json(tool);
  }),

  http.get('*/api/readme/:owner/:repo', ({ params }) => {
    const fullName = `${String(params.owner)}/${String(params.repo)}`;
    const readme = MOCK_READMES[fullName];
    if (!readme) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({ repo: fullName, html: readme.html, truncated: readme.truncated });
  }),
];
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run apps/web/src/mocks/handlers.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/mocks/readmes.ts apps/web/src/mocks/handlers.ts apps/web/src/mocks/handlers.test.ts
git commit -m "feat(web): add mock README fixtures and MSW request handlers"
```

---

### Task 11: Wire mock mode into the app (Layer 1)

**Files:**
- Create: `apps/web/src/mocks/browser.ts`
- Create: `apps/web/src/mocks/start.ts`
- Create: `apps/web/src/vite-env.d.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/package.json`
- Modify: `mise.toml`
- Modify: `.env.example`

- [ ] **Step 1: Write the browser worker and the start entry**

```ts
// apps/web/src/mocks/browser.ts
import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/**
 * The only module that imports `msw/browser`. Kept apart from handlers.ts so the handlers
 * stay loadable under the node test environment.
 */
export const worker = setupWorker(...handlers);
```

```ts
// apps/web/src/mocks/start.ts
import { MOCK_CORPUS, MOCK_SENTINEL } from './corpus/index';
import { worker } from './browser';

/**
 * Starts the development mock backend. Reached only from main.tsx's
 * `import.meta.env.DEV && VITE_MOCK === '1'` branch, which a production build eliminates.
 *
 * Loud, never degrading: a request the mock does not model must fail visibly rather than fall
 * through to a real or absent backend, and a worker that fails to register must throw rather
 * than silently leaving the app talking to nothing. Collapsing a misconfiguration into
 * plausible-looking data is exactly the failure searchErrorMessage() exists to avoid.
 */
export async function startMocks(): Promise<void> {
  await worker.start({
    onUnhandledRequest: 'error',
    quiet: true,
  });

  console.info(
    `%c[keco] mock backend active — ${MOCK_CORPUS.length} fabricated documents, no real data. (${MOCK_SENTINEL})`,
    'color:#b45309;font-weight:bold',
  );
}
```

- [ ] **Step 2: Type the flag**

```ts
// apps/web/src/vite-env.d.ts
/// <reference types="vite/client" />

/**
 * Augments Vite's ImportMetaEnv. Every VITE_-prefixed value here is inlined into the bundle at
 * build time and is public permanently (§12) — never add a secret.
 */
interface ImportMetaEnv {
  /** Search-only Meilisearch key, scoped to `tools`. */
  readonly VITE_MEILI_SEARCH_KEY?: string;
  readonly VITE_MEILI_HOST?: string;
  /** '1' enables the development mock backend. No effect outside `vite dev`. */
  readonly VITE_MOCK?: string;
}
```

- [ ] **Step 3: Wire it into main.tsx**

Replace the final two lines of `apps/web/src/main.tsx` (the `if (container.firstChild)`
branch) with the following, keeping the existing comment above it intact:

```tsx
const render = (): void => {
  if (container.firstChild) hydrateRoot(container, tree);
  else createRoot(container).render(tree);
};

/**
 * The development mock backend (docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md).
 *
 * `import.meta.env.DEV` is first and is not optional: Vite replaces it with the literal
 * `false` in a production build, so Rollup eliminates this branch and the dynamic import with
 * it, and nothing reachable from ./mocks/start is emitted. VITE_MOCK is only ever a second
 * condition narrowing an already dev-only branch — a runtime flag alone is something a
 * deployment environment could set.
 */
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  void import('./mocks/start')
    .then(({ startMocks }) => startMocks())
    .then(render);
} else {
  render();
}
```

- [ ] **Step 4: Add the dev:mock script**

In `apps/web/package.json`, add to `scripts`, after `"dev"`:

```json
    "dev:mock": "msw init public --save && VITE_MOCK=1 vite",
```

- [ ] **Step 5: Add the mise task**

In `mise.toml`, immediately after the `[tasks.web]` block:

```toml
[tasks."web:mock"]
description = "Portal dev server on :5173 with the mock backend — fabricated data, dev only, never in a production build"
run = "pnpm -F @keco/web dev:mock"
```

- [ ] **Step 6: Document the flag**

In `.env.example`, append to the section holding the other `VITE_` variables:

```dotenv
# Set to 1 to run the portal against the in-browser mock backend (apps/web/src/mocks).
# Read by apps/web only, and only under `vite dev` — a production build eliminates the branch,
# so this has no effect on a built bundle. Fabricated data: never point a real deployment here.
VITE_MOCK=
```

- [ ] **Step 7: Verify the whole thing runs**

Run: `mise run web:mock`
Expected: Vite starts on :5173. Open `http://localhost:5173` — the home page shows chip rows
with facet counts and a "Highest momentum" list; the console shows the amber
`[keco] mock backend active — 300 fabricated documents` banner. Click into a curated tool
(for example `/tools/derailed/k9s`) and confirm the README panel renders. Stop with Ctrl-C.

- [ ] **Step 8: Verify production behaviour is unchanged**

Run: `VITE_MOCK=1 pnpm -F @keco/web build`
Expected: build succeeds. Even with the flag set, the next task's scan must find nothing.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/mocks/browser.ts apps/web/src/mocks/start.ts apps/web/src/vite-env.d.ts \
        apps/web/src/main.tsx apps/web/package.json mise.toml .env.example
git commit -m "feat(web): start the mock backend behind a dev-only VITE_MOCK flag"
```

---

### Task 12: Bar mock imports from application code (Layer 3)

The subtle part: `eslint.config.mjs` builds `no-restricted-imports` through the `boundary()`
helper, and flat config is **last-match-wins per rule key**. A new config block naming
`no-restricted-imports` for `apps/web/src` would *replace* the browser-bundle rule, silently
removing the protection that keeps `@keco/cache` and `node:*` out of the bundle. So the
existing block is extended, and the exemption is expressed as a later block that re-applies the
original groups.

**Files:**
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Extract the browser groups and add the mocks group**

Replace the existing `apps/web/src` config block with:

```js
  // The portal bundle ships to strangers. Anything it imports is public, so the rule is not
  // "no write-side packages" but "@keco/core and meilisearch, and nothing else" (§7).
  // @keco/query and @keco/search are read-side and harmless in themselves, but @keco/search
  // carries createAdminClient, which reads MEILI_MASTER_KEY — a bundle must not be one
  // tree-shaking mistake away from that.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: boundary(
      'apps/web/src is a browser bundle: @keco/core and meilisearch only, and no node:* (§7).',
      [...BROWSER_GROUPS, MOCK_GROUP],
    ),
  },

  // The mock backend is development and test only. Application code must never import it, or
  // fabricated repos, scores and install commands reach real readers (§6). main.tsx holds the
  // dev-only branch that loads it; test files use the corpus as fixtures. Nothing else may.
  // This block re-applies BROWSER_GROUPS rather than adding to the one above: flat config is
  // last-match-wins per rule key, so omitting them here would unguard these files entirely.
  {
    files: [
      'apps/web/src/main.tsx',
      'apps/web/src/**/*.test.ts',
      'apps/web/src/mocks/**/*.ts',
    ],
    rules: boundary(
      'apps/web/src is a browser bundle: @keco/core and meilisearch only, and no node:* (§7).',
      BROWSER_GROUPS,
    ),
  },
```

And add these constants immediately below the `boundary` helper at the top of the file:

```js
/** The portal bundle's permanent import ban (§7). Named so the mock rule can re-apply it. */
const BROWSER_GROUPS = [
  ['@keco/cache', '@keco/cache/*', '@keco/github', '@keco/signals', '@keco/analyze'],
  ['@keco/query', '@keco/search'],
  ['node:*', 'fs', 'path', 'crypto', 'os'],
];

/** Development-and-test-only mock backend — see the governing invariant in its design spec. */
const MOCK_GROUP = ['**/mocks', '**/mocks/*', '**/mocks/**'];
```

- [ ] **Step 2: Verify the rule bites**

Temporarily add this import to the top of `apps/web/src/routes/home.tsx`:

```tsx
import { MOCK_CORPUS } from '../mocks/corpus/index';
console.log(MOCK_CORPUS.length);
```

Run: `pnpm eslint apps/web/src/routes/home.tsx`
Expected: an error naming the mocks restriction.

- [ ] **Step 3: Verify the exemptions still work**

Remove the temporary import from `home.tsx`, then run: `pnpm eslint apps/web/src`
Expected: no errors — `main.tsx`, the tests and the mocks themselves are exempt, and every
other file is still barred from `@keco/cache`, `@keco/query`, `@keco/search` and `node:*`.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(web): bar mock imports from application code"
```

---

### Task 13: Assert the mock is absent from production builds (Layer 4)

Static elimination is a property of the bundler's behaviour, and bundler behaviour changes
across major versions. This layer measures the artifact rather than trusting the mechanism, and
it is the one that actually holds the invariant.

**Files:**
- Create: `apps/web/scripts/assert-no-mocks.ts`
- Test: `apps/web/scripts/assert-no-mocks.test.ts`
- Modify: `vitest.config.ts`
- Modify: `apps/web/package.json`
- Modify: `mise.toml`

- [ ] **Step 1: Let vitest see the scripts directory**

In `vitest.config.ts`, add to `include`, after the `apps/*/prerender/**/*.test.ts` line:

```ts
      'apps/*/scripts/**/*.test.ts',
```

- [ ] **Step 2: Write the failing test**

Including a negative case: a scanner with a broken glob passes forever and proves nothing, so
the test requires it to actually fail when it should.

```ts
// apps/web/scripts/assert-no-mocks.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOCK_MARKERS, scanForMocks } from './assert-no-mocks';

const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'keco-scan-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return root;
};

describe('scanForMocks', () => {
  it('finds nothing in a clean build', () => {
    const root = fixture({ 'assets/app.js': 'console.log("hello");', 'index.html': '<!doctype html>' });
    expect(scanForMocks(root)).toEqual([]);
  });

  it('detects the corpus sentinel, recursively', () => {
    const root = fixture({ 'assets/nested/chunk.js': 'const s="KECO_MOCK_CORPUS_DO_NOT_SHIP";' });
    const findings = scanForMocks(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('KECO_MOCK_CORPUS_DO_NOT_SHIP');
  });

  it('detects the MSW service worker', () => {
    const root = fixture({ 'mockServiceWorker.js': '/* Mock Service Worker */' });
    expect(scanForMocks(root)).not.toEqual([]);
  });

  it('detects the MSW runtime by a distinctive option name', () => {
    const root = fixture({ 'assets/app.js': 'start({onUnhandledRequest:"error"})' });
    expect(scanForMocks(root)).not.toEqual([]);
  });

  it('does not false-positive on short incidental substrings', () => {
    // "msw" occurs by chance in minified identifiers and hashed filenames. A guard that cries
    // wolf is a guard someone switches off, so bare "msw" is deliberately not a marker.
    const root = fixture({ 'assets/index-msw8chq.js': 'const amswitch=1;' });
    expect(scanForMocks(root)).toEqual([]);
  });

  it('declares markers that are all distinctive', () => {
    for (const marker of MOCK_MARKERS) expect(marker.length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run apps/web/scripts/assert-no-mocks.test.ts`
Expected: FAIL — `Failed to resolve import "./assert-no-mocks"`

- [ ] **Step 4: Write the scanner**

`apps/web/scripts/` is outside `apps/web/src`, so the §7 browser-bundle lint rule does not
apply and `node:fs` is correct here.

```ts
// apps/web/scripts/assert-no-mocks.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Layer 4 of the mock backend's governing invariant
 * (docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md): the mock must never reach
 * a production build.
 *
 * Layers 1–3 and 5 describe intent — a build-time guard, a dev-only dependency, a lint rule, a
 * gitignored worker script. This one measures the artifact, because dead-code elimination is a
 * property of the bundler's behaviour and bundler behaviour changes across major versions.
 */

/**
 * Distinctive strings only. Bare "msw" is deliberately excluded: it occurs by chance in
 * minified identifiers and hashed asset names, and a guard that false-positives is a guard
 * someone switches off.
 */
export const MOCK_MARKERS = [
  'KECO_MOCK_CORPUS_DO_NOT_SHIP',
  'mockServiceWorker',
  'onUnhandledRequest',
] as const;

const TEXT_FILE = /\.(js|mjs|cjs|css|html|json|map|txt)$/i;

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Returns one human-readable finding per (file, marker) hit. Empty means clean. */
export function scanForMocks(root: string): string[] {
  const findings: string[] = [];

  for (const path of walk(root)) {
    if (!TEXT_FILE.test(path)) continue;
    const contents = readFileSync(path, 'utf8');
    for (const marker of MOCK_MARKERS) {
      if (contents.includes(marker)) {
        findings.push(`${relative(root, path)} contains "${marker}"`);
      }
    }
  }

  return findings;
}

/** CLI entry: `tsx scripts/assert-no-mocks.ts [dist-dir]`. */
const invokedDirectly = process.argv[1]?.endsWith('assert-no-mocks.ts') ?? false;
if (invokedDirectly) {
  const root = process.argv[2] ?? 'dist';
  const findings = scanForMocks(root);

  if (findings.length > 0) {
    console.error(`\n✗ Mock backend artifacts found in ${root} — this must never ship:\n`);
    for (const finding of findings) console.error(`    ${finding}`);
    console.error('\nThe mock is development and test only. See the governing invariant in');
    console.error('docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md\n');
    process.exit(1);
  }

  console.info(`✓ ${root} is free of mock backend artifacts`);
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run apps/web/scripts/assert-no-mocks.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 6: Wire it into the build**

In `apps/web/package.json`, add to `scripts`:

```json
    "assert:no-mocks": "node --import tsx scripts/assert-no-mocks.ts dist",
```

In `mise.toml`, add the step to `[tasks.build]`'s `run` array, after the prerender line and
before the API typecheck:

```toml
  "pnpm -F @keco/web assert:no-mocks",
```

- [ ] **Step 7: Prove it against a real build, including the adversarial case**

Run: `VITE_MOCK=1 pnpm -F @keco/web build && pnpm -F @keco/web assert:no-mocks`
Expected: `✓ dist is free of mock backend artifacts` — the flag being set at build time changes
nothing, because `import.meta.env.DEV` already eliminated the branch.

Then confirm the guard fails when it should:

Run: `echo 'KECO_MOCK_CORPUS_DO_NOT_SHIP' > apps/web/dist/canary.js && pnpm -F @keco/web assert:no-mocks; rm apps/web/dist/canary.js`
Expected: non-zero exit listing `canary.js contains "KECO_MOCK_CORPUS_DO_NOT_SHIP"`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/scripts/assert-no-mocks.ts apps/web/scripts/assert-no-mocks.test.ts \
        vitest.config.ts apps/web/package.json mise.toml
git commit -m "chore(web): fail the build if mock artifacts reach dist"
```

---

### Task 14: Documentation

**Files:**
- Modify: `CLAUDE.md` (§8 table and §14)
- Modify: `apps/web/README.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Add the command to CLAUDE.md §8**

`AGENTS.md` is a symlink to `CLAUDE.md`, so this edit covers both. In the §8 command table,
after the `mise run web` / `mise run api` row:

```markdown
| `mise run web:mock` | Portal alone on `:5173` against the in-browser mock backend — fabricated data, **dev and test only**, provably absent from production builds (§14) |
```

- [ ] **Step 2: Add the warning to CLAUDE.md §14**

In §14's "Frontend and API" group, directly after the `VITE_`-prefixed variables bullet:

```markdown
- **The mock backend is development and test only** (`apps/web/src/mocks`, `mise run web:mock`).
  It serves fabricated repos, scores and `install_methods` — shipping it would put invented
  `brew install` lines in front of real readers, which §6 names as the worst bug this project
  can ship. Five layers keep it out: the `import.meta.env.DEV` guard in `main.tsx`, `msw` as a
  `devDependency`, a lint rule barring `src/mocks/**` imports outside `main.tsx` and tests, a
  `dist/` scan wired into `mise run build`, and a gitignored worker script. Adding a production
  path to it reverses a recorded decision and needs an ADR.
```

- [ ] **Step 3: Document it in apps/web/README.md**

Append a section:

```markdown
## Development mock backend

`mise run web:mock` runs the portal on `:5173` with an in-browser mock backend — no Docker, no
Meilisearch, no API process, no GitHub token. MSW intercepts the portal's real requests and
answers them from ~300 fixture documents (~30 real projects, the rest deterministically
generated).

**It is for development and test only, and never ships.** The data is fabricated: invented
repositories, invented scores and — for generated entries — invented install commands.
`mise run build` runs `assert:no-mocks`, which fails the build if any mock artifact reaches
`dist/`.

**What it covers:** search, facet distributions, momentum, single-document lookup, and
`GET /api/readme/{owner}/{repo}` for curated repos.

**What it does not cover:** `/api/v1`, `/api/mcp`, `/api/chat`, `/api/admin/*`,
`/api/commands/*`, and the backoffice. The portal does not call them.

**What it must not be trusted for:** relevance ordering, `searchableAttributes` weighting, and
validating a filter expression. The engine approximates Meilisearch over the closed grammar
`buildFilters()` and `sortSpec()` emit; it is not Meilisearch. Verify anything ranking-related
against a real index (`mise run infra:up`).

Generated repos deliberately have no README fixture, so the tool page's "no cached README"
state — ordinary before the crawler reaches a repo — shows up in normal use.
```

- [ ] **Step 4: Note it in ROADMAP.md**

Add under the read-side v1 items:

```markdown
- ✅ **Portal mock backend** — dev-and-test-only MSW corpus so frontend work needs no crawl.
  Never in a production build; see `docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md apps/web/README.md ROADMAP.md
git commit -m "docs: document the dev-and-test-only portal mock backend"
```

---

### Task 15: Full verification

- [ ] **Step 1: Run the whole gate**

Run: `mise run ci`
Expected: check, lint, test and taxonomy:check all green. §15.1 of CLAUDE.md.

- [ ] **Step 2: Confirm the production build is clean**

Run: `mise run build`
Expected: succeeds, ending with `✓ dist is free of mock backend artifacts`.

- [ ] **Step 3: Confirm the mock still runs**

Run: `mise run web:mock`
Expected: the portal serves 300 documents at `http://localhost:5173` with the amber console
banner. Search for `kubectx`, apply a `kind` filter, page through results, and open a curated
tool page to see its README. Stop with Ctrl-C.

- [ ] **Step 4: Confirm the real path still works**

Run: `mise run web`
Expected: the portal starts without the banner and without mock data. With no Meilisearch
running it shows the ordinary "Search is unavailable right now." message — **not** fixture
data. That distinction is the point of rejecting auto-fallback.

- [ ] **Step 5: Commit anything outstanding**

```bash
git status
```

Expected: clean.

---

## Definition of done

Against CLAUDE.md §15 and the spec's governing invariant:

1. `mise run ci` green.
2. No write-side, read-model or API contract change — §15.2–§15.4 do not apply.
3. §15.5: the tool page still prerenders, search is unaffected, and **no `VITE_`-prefixed
   secret entered the bundle** (`VITE_MOCK` is a flag, not a secret).
4. §15.6: nothing on the read side writes a read model. The mock is read-only.
5. The invariant holds and is measured: `assert:no-mocks` passes against a real `dist/` built
   with `VITE_MOCK=1` set, and fails against a planted canary.
