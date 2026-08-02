# Taxonomy as YAML — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Keco's classification vocabulary out of hard-coded TypeScript enums into a single declarative `packages/core/taxonomy.yaml` covering eight families, wire it through the analyzer, the search settings, the query layer and the portal home page.

**Architecture:** `taxonomy.yaml` is parsed once at module load in `@keco/core`, zod-validated, and exposed through accessor functions. Everything downstream — classification rules, Meilisearch `filterableAttributes`, the query filter builder, the home-page chip rows — derives from those accessors instead of hard-coded lists. Types degrade from literal unions to `string`, and a pinning test replaces the compile-time safety that costs.

**Tech Stack:** TypeScript (strict, ESM), zod 4, the `yaml` package, vitest, Next.js 16 App Router, Meilisearch, pnpm workspaces, mise.

**Spec:** [docs/superpowers/specs/2026-08-01-taxonomy-yaml-design.md](../specs/2026-08-01-taxonomy-yaml-design.md)

---

## Deviations from the spec

Two, both tightenings. Raise them with the author before Task 7 if either is unwelcome.

1. **`governance` drops the contributor-concentration heuristic.** The spec proposed `community` for "an org account with a spread of contributors". That is a guess dressed as a fact: HashiCorp orgs have hundreds of contributors and are not community-governed. The rule now emits `community` only on landscape evidence, `individual` only on a GitHub `User` account type, and `unknown` otherwise. `contributors` is not part of the rule input.
2. **`taxonomyForClient()` is not implemented.** `TAXONOMY` is already a plain zod-parsed object tree, safe to pass as props with no conversion, and no client component reads it in this plan. Adding the function now would be an unused export.

## Prerequisite knowledge

Read before starting: `CLAUDE.md` §2 (CQRS), §5 (read models), §6 (taxonomy), §13 (conventions), §15 (definition of done).

Facts about the repo that matter here:

- The crawler, analyzer passes and projector are **not implemented** — they are stubs with TODO comments. Nothing writes to Meilisearch yet, so the index is empty in dev. Every UI change in this plan must render correctly against an empty index.
- Because nothing is indexed yet, no migration is needed: there is no corpus to re-project. The spec's migration section applies to the first real crawl, not to this change.
- `mise run ci` is the gate: `check` (tsc), `lint` (eslint incl. import boundaries), `test` (vitest).
- Vitest only collects `packages/*/src/**/*.test.ts` and `apps/*/src/**/*.test.ts` — **`.ts` only, not `.tsx`**, and the environment is `node` with no DOM. That is why UI logic in Task 11 lives in a plain `.ts` module.

## File structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/core/taxonomy.yaml` | The vocabulary. The only file you edit to add a value. |
| `packages/core/src/taxonomy-schema.ts` | Zod shape of the file plus `parseTaxonomy(text)` — pure, no filesystem. |
| `packages/core/src/taxonomy-schema.test.ts` | Parser and cross-check tests, driven by inline YAML strings. |
| `packages/core/src/taxonomy.test.ts` | Tests the accessors against the real committed file. |
| `packages/core/src/bin/check-taxonomy.ts` | Standalone validator for `mise run taxonomy:check`. |
| `packages/analyze/src/rules/runtime.ts` | Pass-1 rules for the `runtime` family. |
| `packages/analyze/src/rules/derived.ts` | Pass-1 rules for `license_class`, `openness`, `maturity`, `governance`. |
| `packages/analyze/src/rules/fixtures.test.ts` | One suite running every fixture through every pass-1 classifier. |
| `packages/analyze/src/rules/pinning.test.ts` | Asserts every value a rule can emit exists in the YAML. |
| `packages/analyze/fixtures/_synthetic__open-core.json` | Licence/marker combination not yet in the real corpus. |
| `packages/analyze/fixtures/_synthetic__source-available.json` | Same, for a BUSL-style licence. |
| `packages/query/src/filters.ts` | Pure Meilisearch filter/facet construction. No client, no I/O. |
| `packages/query/src/filters.test.ts` | Tests for the above. |
| `apps/web/src/lib/topics.ts` | Turns a facet distribution into renderable chip rows. Pure. |
| `apps/web/src/lib/topics.test.ts` | Tests for the above. |
| `apps/web/src/app/(portal)/topic-chips.tsx` | Renders the rows. JSX only, no logic. |

**Modified:** `packages/core/src/taxonomy.ts` (rewritten as a loader), `packages/core/src/schemas.ts`, `packages/core/package.json`, `packages/analyze/src/rules/kind.ts`, `packages/analyze/src/index.ts`, the four existing fixtures, `packages/analyze/src/rules/kind.test.ts` (deleted — replaced by `fixtures.test.ts`), `packages/search/src/settings.ts`, `packages/query/src/index.ts`, `apps/web/src/app/(portal)/page.tsx`, `apps/web/src/app/(portal)/search/page.tsx`, `apps/web/next.config.ts`, `mise.toml`, `docs/taxonomy.md`, `CLAUDE.md`.

---

## Task 1: The taxonomy file schema and parser

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/taxonomy-schema.ts`
- Test: `packages/core/src/taxonomy-schema.test.ts`

- [ ] **Step 1: Add the `yaml` dependency**

Edit `packages/core/package.json`, adding `yaml` to `dependencies`:

```json
  "dependencies": {
    "yaml": "^2.8.1",
    "zod": "^4.4.3"
  },
```

Then install:

```bash
pnpm install
```

Expected: `+ yaml 2.8.x` in the output, `pnpm-lock.yaml` modified.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/taxonomy-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseTaxonomy } from './taxonomy-schema';

/**
 * The parser is pure — it takes text, not a path — precisely so these tests can drive it
 * with deliberately broken files without writing anything to disk.
 */
const valid = `
version: 1
families:
  - id: kind
    label: Kind
    param: kind
    description: What the artifact is.
    cardinality: one
    source: analyzer
    facet: true
    values:
      - id: cli
        label: CLI
        description: A command-line binary.
        aliases: [cli, command-line]
      - id: operator
        label: Operator
        description: A CRD plus its controller.
  - id: openness
    label: Openness
    param: openness
    description: Whether the whole product is open source.
    cardinality: one
    source: derived
    values:
      - id: fully-open
        label: Fully open
        description: Everything is under an OSI licence.
      - id: unknown
        label: Unknown
        description: Not enough evidence.
        hidden: true
`;

describe('parseTaxonomy', () => {
  it('parses a valid file', () => {
    const taxonomy = parseTaxonomy(valid);
    expect(taxonomy.version).toBe(1);
    expect(taxonomy.families).toHaveLength(2);
    expect(taxonomy.families[0]!.values[0]!.id).toBe('cli');
  });

  it('defaults aliases to empty and hidden to false', () => {
    const kind = parseTaxonomy(valid).families[0]!;
    expect(kind.values[1]!.aliases).toEqual([]);
    expect(kind.values[1]!.hidden).toBe(false);
  });

  it('rejects a duplicate family id', () => {
    const text = valid + valid.slice(valid.indexOf('  - id: kind'));
    expect(() => parseTaxonomy(text)).toThrow(/duplicate family id: kind/);
  });

  it('rejects a duplicate value id within a family', () => {
    const text = valid.replace('      - id: operator', '      - id: cli');
    expect(() => parseTaxonomy(text)).toThrow(/duplicate value id: kind\/cli/);
  });

  it('rejects a duplicate alias within a family', () => {
    const text = valid.replace('aliases: [cli, command-line]', 'aliases: [cli, cli]');
    expect(() => parseTaxonomy(text)).toThrow(/duplicate alias: kind\/cli/);
  });

  it('rejects a derived family with no unknown value', () => {
    const text = valid.replace('      - id: unknown', '      - id: mystery');
    expect(() => parseTaxonomy(text)).toThrow(/derived family openness has no "unknown" value/);
  });

  it('rejects min or max on a cardinality: one family', () => {
    const text = valid.replace('    cardinality: one\n    source: analyzer', '    cardinality: one\n    max: 3\n    source: analyzer');
    expect(() => parseTaxonomy(text)).toThrow(/family kind is cardinality: one and cannot declare min or max/);
  });

  it('rejects min greater than max', () => {
    const text = valid.replace(
      '    cardinality: one\n    source: analyzer',
      '    cardinality: many\n    min: 4\n    max: 3\n    source: analyzer',
    );
    expect(() => parseTaxonomy(text)).toThrow(/family kind has min 4 greater than max 3/);
  });

  it('rejects a duplicate param across families', () => {
    const text = valid.replace('    param: openness', '    param: kind');
    expect(() => parseTaxonomy(text)).toThrow(/duplicate family param: kind/);
  });

  it('rejects malformed YAML', () => {
    expect(() => parseTaxonomy('version: 1\nfamilies: [')).toThrow();
  });

  it('rejects an unknown source', () => {
    const text = valid.replace('source: analyzer', 'source: magic');
    expect(() => parseTaxonomy(text)).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run packages/core/src/taxonomy-schema.test.ts
```

Expected: FAIL — `Failed to resolve import "./taxonomy-schema"`.

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/taxonomy-schema.ts`:

```ts
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * The shape of `packages/core/taxonomy.yaml` (AGENTS.md §6). This module is pure: it takes
 * text, never a path, so the loader can decide where the file lives and the tests can drive
 * broken files through it without touching disk.
 *
 * Zod covers the shape. The cross-family invariants below cannot be expressed in the shape
 * and are checked afterwards, each with a message naming the offending id — a taxonomy that
 * fails to load takes every worker and the web app down, so the message must be enough to
 * fix the file without a debugger.
 */
export const TaxonomyValueSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'value ids are lower-kebab-case'),
  label: z.string().min(1),
  description: z.string().min(1),
  /** External identifiers that map to this value: GitHub topics, SPDX ids. Lowercased on read. */
  aliases: z.array(z.string()).default([]),
  /** Never rendered as a chip. `unknown` is always hidden. */
  hidden: z.boolean().default(false),
});
export type TaxonomyValue = z.infer<typeof TaxonomyValueSchema>;

export const TaxonomyFamilySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'family ids are lower_snake_case'),
  label: z.string().min(1),
  /** The URL query parameter. Differs from `id` where a plural reads badly (domains → domain). */
  param: z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'params are lower_snake_case'),
  description: z.string().min(1),
  cardinality: z.enum(['one', 'many']),
  /** `cardinality: many` only. Absent means unbounded. */
  min: z.number().int().min(0).optional(),
  max: z.number().int().min(1).optional(),
  /** Who assigns it: analyzer rules, derivation from metadata, or a registry with proof. */
  source: z.enum(['analyzer', 'derived', 'registry']),
  /** Whether it renders as a home-page chip row. */
  facet: z.boolean().default(true),
  values: z.array(TaxonomyValueSchema).min(1),
});
export type TaxonomyFamily = z.infer<typeof TaxonomyFamilySchema>;

export const TaxonomyFileSchema = z.object({
  version: z.literal(1),
  families: z.array(TaxonomyFamilySchema).min(1),
});
export type TaxonomyFile = z.infer<typeof TaxonomyFileSchema>;

const fail = (message: string): never => {
  throw new Error(`taxonomy: ${message}`);
};

/** Parses and fully validates the file. Throws with an actionable message on any problem. */
export function parseTaxonomy(text: string): TaxonomyFile {
  const file = TaxonomyFileSchema.parse(parseYaml(text));

  const familyIds = new Set<string>();
  const params = new Set<string>();

  for (const family of file.families) {
    if (familyIds.has(family.id)) fail(`duplicate family id: ${family.id}`);
    familyIds.add(family.id);

    if (params.has(family.param)) fail(`duplicate family param: ${family.param}`);
    params.add(family.param);

    if (family.cardinality === 'one' && (family.min !== undefined || family.max !== undefined)) {
      fail(`family ${family.id} is cardinality: one and cannot declare min or max`);
    }
    if (family.min !== undefined && family.max !== undefined && family.min > family.max) {
      fail(`family ${family.id} has min ${family.min} greater than max ${family.max}`);
    }

    const valueIds = new Set<string>();
    const aliases = new Set<string>();
    for (const value of family.values) {
      if (valueIds.has(value.id)) fail(`duplicate value id: ${family.id}/${value.id}`);
      valueIds.add(value.id);

      for (const alias of value.aliases) {
        const key = alias.toLowerCase();
        // One alias must map to exactly one value, or classification becomes order-dependent.
        if (aliases.has(key)) fail(`duplicate alias: ${family.id}/${key}`);
        aliases.add(key);
      }
    }

    // Absence of evidence must never become a positive claim (§4.2).
    if (family.source === 'derived' && !valueIds.has('unknown')) {
      fail(`derived family ${family.id} has no "unknown" value`);
    }
  }

  return file;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm vitest run packages/core/src/taxonomy-schema.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/src/taxonomy-schema.ts packages/core/src/taxonomy-schema.test.ts pnpm-lock.yaml
git commit -m "feat(core): taxonomy file schema and parser"
```

---

## Task 2: Author the taxonomy file

**Files:**
- Create: `packages/core/taxonomy.yaml`

This task is data entry with one test at the end. The content below is the deliverable — type it exactly. Every `aliases` entry under `domains` is copied from the `DOMAIN_TOPICS` map currently in `packages/analyze/src/rules/kind.ts:148-191`; deleting that map in Task 5 must not change any fixture's expected domains, so do not drop or rename an existing alias.

- [ ] **Step 1: Create the file**

Create `packages/core/taxonomy.yaml`:

```yaml
# Keco's classification vocabulary — the closed vocabulary of AGENTS.md §6.
#
# This file is the source of truth. Adding a value is a deliberate PR with its rationale in
# docs/taxonomy.md, a rule that detects it, and a fixture proving the rule.
#
# `aliases` map an external identifier to a value: GitHub topics for `domains`, SPDX ids for
# `license_class`. Matching is case-insensitive. An alias may appear once per family.
#
# Every family whose classification can fail declares `unknown`, and `unknown` is always
# hidden from the UI. Absence of evidence is never a positive claim.
version: 1

families:
  # ── assigned by the analyzer ───────────────────────────────────────────────
  - id: kind
    label: Kind
    param: kind
    description: What the artifact is. Exactly one per tool.
    cardinality: one
    source: analyzer
    facet: true
    values:
      - id: cli
        label: CLI
        description: A standalone command-line binary you run against a cluster or locally.
      - id: kubectl-plugin
        label: kubectl plugin
        description: A binary invoked as `kubectl <name>`, usually distributed through krew.
      - id: operator
        label: Operator
        description: Custom resources plus the controller that reconciles them.
      - id: controller
        label: Controller
        description: A reconciliation loop over existing Kubernetes resources, with no CRDs of its own.
      - id: helm-chart
        label: Helm chart
        description: A packaged deployment of something else, distributed as a chart.
      - id: crd-library
        label: CRD library
        description: Custom resource definitions and generated clients, with no controller.
      - id: admission-webhook
        label: Admission webhook
        description: A validating or mutating webhook that intercepts API server requests.
      - id: distribution
        label: Distribution
        description: A Kubernetes distribution or installer that produces a cluster.
      - id: dashboard-ui
        label: Dashboard / UI
        description: A graphical or terminal interface for inspecting and operating clusters.
      - id: library-sdk
        label: Library / SDK
        description: Code you import into your own program rather than run.
      - id: terraform-provider
        label: Terraform provider
        description: A Terraform provider for Kubernetes or an ecosystem service.
      - id: ide-extension
        label: IDE extension
        description: An editor or IDE plugin for working with Kubernetes manifests and clusters.
      - id: service
        label: Service
        description: A long-running server or platform component that is none of the above.
      - id: learning-resource
        label: Learning resource
        description: Courses, cheatsheets, curated lists and books. Not a tool.

  - id: domains
    label: Domain
    param: domain
    description: What problem the tool solves. One to three per tool.
    cardinality: many
    min: 1
    max: 3
    source: analyzer
    facet: true
    values:
      - id: networking
        label: Networking
        description: CNI plugins, ingress, load balancing, DNS and cluster connectivity.
        aliases: [networking, cni, ingress, load-balancer]
      - id: security
        label: Security
        description: Image and cluster scanning, RBAC, runtime security and supply-chain integrity.
        aliases: [security, rbac]
      - id: policy
        label: Policy
        description: Admission policy, governance rules and their enforcement engines.
        aliases: [policy, opa]
      - id: storage
        label: Storage
        description: CSI drivers, volume management and persistent data plumbing.
        aliases: [storage, csi]
      - id: database
        label: Database
        description: Data stores and the operators that run them — relational, key-value, document, streaming.
        aliases: [database, databases, postgresql, postgres, mysql, mariadb, redis, mongodb, cassandra, kafka, etcd, clickhouse]
      - id: observability
        label: Observability
        description: Metrics, logs, traces, profiling and the dashboards over them.
        aliases: [observability, monitoring, prometheus, tracing, logging]
      - id: ci-cd
        label: CI/CD
        description: Build and deployment pipelines, release automation and progressive delivery.
        aliases: [ci-cd, cicd]
      - id: gitops
        label: GitOps
        description: Git as the source of truth for cluster state, and the agents that reconcile it.
        aliases: [gitops, argocd, flux]
      - id: packaging
        label: Packaging
        description: Charts, manifests, templating and the distribution of deployable artifacts.
        aliases: [helm, packaging]
      - id: autoscaling
        label: Autoscaling
        description: Scaling workloads and nodes to match demand.
        aliases: [autoscaling, hpa]
      - id: scheduling
        label: Scheduling
        description: Placement, batch queues, gang scheduling and bin-packing. Where pods land, not how many.
        aliases: [scheduling, scheduler, batch, job-queue]
      - id: cost
        label: Cost
        description: Spend visibility, allocation and rightsizing.
        aliases: [finops, cost]
      - id: multi-cluster
        label: Multi-cluster
        description: Federation, fleet management and workloads spanning clusters.
        aliases: [multi-cluster, federation]
      - id: backup-dr
        label: Backup & DR
        description: Snapshots, restores, migration and disaster recovery.
        aliases: [backup, disaster-recovery]
      - id: service-mesh
        label: Service mesh
        description: Sidecar and ambient meshes, traffic policy and mTLS between services.
        aliases: [service-mesh, istio, envoy]
      - id: secrets
        label: Secrets
        description: Secret storage, injection, rotation and external secret managers.
        aliases: [secrets, secrets-management, vault, sealed-secrets]
      - id: serverless
        label: Serverless
        description: Scale-to-zero runtimes, functions and event-driven workloads.
        aliases: [serverless, faas, knative, event-driven]
      - id: dev-experience
        label: Developer experience
        description: Local clusters, inner-loop tooling and everything that shortens the edit-deploy cycle.
        aliases: [developer-tools]
      - id: testing
        label: Testing
        description: Conformance, end-to-end, chaos and load testing.
        aliases: [testing]
      - id: ai-ml
        label: AI / ML
        description: Training, serving and orchestrating models on Kubernetes.
        aliases: [machine-learning, mlops, llm]
      - id: edge
        label: Edge
        description: Small-footprint, intermittently connected and IoT deployments.
        aliases: [edge, iot]
      - id: troubleshooting
        label: Troubleshooting
        description: Debugging, diagnostics and understanding why a cluster is unhappy.
        aliases: [debugging, troubleshooting]

  - id: runtime
    label: Runtime
    param: runtime
    description: Where the thing actually executes.
    cardinality: one
    source: analyzer
    facet: true
    values:
      - id: in-cluster
        label: In cluster
        description: Runs as a workload inside the cluster.
      - id: workstation
        label: Workstation
        description: Runs on your own machine and talks to a cluster.
      - id: ci-pipeline
        label: CI pipeline
        description: Runs as a step in a build or deployment pipeline.
      - id: in-your-code
        label: In your code
        description: A library you import; it has no process of its own.
      - id: cluster-itself
        label: The cluster itself
        description: Creates or is the cluster, rather than running on one.
      - id: hosted-service
        label: Hosted service
        description: A managed control plane you connect to rather than run.
      - id: unknown
        label: Unknown
        description: Not enough evidence to say where it runs.
        hidden: true

  # ── proven against a registry ──────────────────────────────────────────────
  - id: install_methods
    label: Install method
    param: install
    description: >-
      How you actually get it. Detected and proven against a registry, never guessed — every
      entry carries a verified command and a source URL. People paste these into a terminal.
    cardinality: many
    source: registry
    facet: true
    values:
      - id: brew
        label: Homebrew
        description: A Homebrew formula or cask.
      - id: mise
        label: mise
        description: A mise-en-place tool registry entry.
      - id: asdf
        label: asdf
        description: An asdf plugin.
      - id: krew
        label: krew
        description: A kubectl plugin published in the krew index.
      - id: helm
        label: Helm
        description: A chart in a published Helm repository.
      - id: kubectl-apply
        label: kubectl apply
        description: Manifests applied directly from a published URL.
      - id: go-install
        label: go install
        description: Installable with `go install`.
      - id: cargo
        label: cargo
        description: Published on crates.io.
      - id: npm
        label: npm
        description: Published on the npm registry.
      - id: pip
        label: pip
        description: Published on PyPI.
      - id: nix
        label: Nix
        description: Packaged in nixpkgs.
      - id: arkade
        label: arkade
        description: Available through the arkade marketplace.
      - id: apt
        label: apt
        description: Published in an apt repository.
      - id: container-image
        label: Container image
        description: Published as a runnable container image.
      - id: curl-script
        label: curl script
        description: An install script fetched over HTTPS and executed.
      - id: github-release
        label: GitHub release
        description: A prebuilt binary attached to a GitHub release.
      - id: operator-hub
        label: OperatorHub
        description: Published on OperatorHub.

  # ── derived from cached metadata ───────────────────────────────────────────
  - id: license_class
    label: Licence
    param: license_class
    description: The licence family, bucketed from the SPDX identifier GitHub reports.
    cardinality: one
    source: derived
    facet: true
    values:
      - id: permissive
        label: Permissive
        description: Use, modify and redistribute with attribution. Apache, MIT, BSD, ISC.
        # Careful: BSL-1.0 is the Boost Software Licence (permissive). BUSL-1.1 is the
        # Business Source Licence (source-available). One character, opposite meanings.
        aliases: [apache-2.0, mit, bsd-2-clause, bsd-3-clause, isc, 0bsd, zlib, bsl-1.0, ncsa, python-2.0, artistic-2.0, postgresql]
      - id: weak-copyleft
        label: Weak copyleft
        description: Changes to the files themselves must be shared; linking is unrestricted.
        aliases: [mpl-2.0, lgpl-2.1, lgpl-3.0, epl-1.0, epl-2.0, cddl-1.0, ms-pl]
      - id: copyleft
        label: Copyleft
        description: Derivative works must carry the same licence. GPL, AGPL.
        aliases: [gpl-2.0, gpl-3.0, agpl-3.0, osl-3.0, eupl-1.2]
      - id: source-available
        label: Source available
        description: The source is published but the licence restricts commercial use. BUSL, Elastic, SSPL.
        aliases: [busl-1.1, elastic-2.0, sspl-1.0]
      - id: public-domain
        label: Public domain
        description: Dedicated to the public domain or equivalent.
        aliases: [unlicense, cc0-1.0, wtfpl]
      - id: unknown
        label: Unknown
        description: No licence detected, or one GitHub could not identify.
        hidden: true

  - id: openness
    label: Openness
    param: openness
    description: >-
      Whether the whole product is open source, or the repository is the free tier of a
      commercial one. Promoted to `fully-open` only on positive evidence.
    cardinality: one
    source: derived
    facet: true
    values:
      - id: fully-open
        label: Fully open
        description: An OSI-approved licence and no sign of a separate commercial edition.
      - id: open-core
        label: Open core
        description: An OSI-approved licence alongside an enterprise or commercial edition.
      - id: source-available
        label: Source available
        description: Published under a licence that restricts commercial use.
      - id: unknown
        label: Unknown
        description: Not enough evidence to make a claim about openness.
        hidden: true

  - id: maturity
    label: Maturity
    param: maturity
    description: How settled the project is, from CNCF status where it exists and from age and activity otherwise.
    cardinality: one
    source: derived
    facet: true
    values:
      - id: cncf-graduated
        label: CNCF graduated
        description: Graduated in the CNCF landscape.
      - id: cncf-incubating
        label: CNCF incubating
        description: Incubating in the CNCF landscape.
      - id: cncf-sandbox
        label: CNCF sandbox
        description: In the CNCF sandbox.
      - id: established
        label: Established
        description: Over two years old, with a release in the last six months.
      - id: young
        label: Young
        description: Under a year old. Promising or unproven; too early to tell.
      - id: dormant
        label: Dormant
        description: No commits pushed in over a year.
      - id: archived
        label: Archived
        description: Marked archived on GitHub. Read-only and unmaintained.
      - id: unknown
        label: Unknown
        description: Not enough evidence to place it.
        hidden: true

  - id: governance
    label: Governance
    param: governance
    description: Who steers the project. Evidence-only — an org account alone proves nothing.
    cardinality: one
    source: derived
    facet: true
    values:
      - id: foundation
        label: Foundation
        description: Owned by a foundation or an upstream Kubernetes organisation.
      - id: vendor-backed
        label: Vendor backed
        description: Owned by a company, per the CNCF landscape.
      - id: community
        label: Community
        description: Community-governed, per the CNCF landscape.
      - id: individual
        label: Individual
        description: Owned by a personal GitHub account.
      - id: unknown
        label: Unknown
        description: Not enough evidence to say who steers it.
        hidden: true
```

- [ ] **Step 2: Verify it parses**

Create a throwaway check (do not commit it):

```bash
pnpm tsx -e "import {parseTaxonomy} from './packages/core/src/taxonomy-schema.ts'; import {readFileSync} from 'node:fs'; const t = parseTaxonomy(readFileSync('packages/core/taxonomy.yaml','utf8')); console.log(t.families.map(f => f.id + ':' + f.values.length).join(' '));"
```

Expected output exactly:

```
kind:14 domains:22 runtime:7 install_methods:17 license_class:6 openness:4 maturity:8 governance:5
```

If a count differs, a value was mistyped or dropped — fix the YAML, do not adjust the expectation.

- [ ] **Step 3: Commit**

```bash
git add packages/core/taxonomy.yaml
git commit -m "feat(core): declare the eight classifier families in taxonomy.yaml"
```

---

## Task 3: The loader and accessors

**Files:**
- Modify: `packages/core/src/taxonomy.ts` (full rewrite)
- Test: `packages/core/src/taxonomy.test.ts`

The old file's exports (`KINDS`, `DOMAINS`, `INSTALL_METHODS`, `Kind`, `Domain`, `InstallMethod`, `Domains`, `FALLBACK_KIND`, `isKind`, `isDomain`, `isInstallMethod`) are all consumed elsewhere and must keep working, now derived from the YAML.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/taxonomy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DOMAINS,
  Domains,
  FALLBACK_KIND,
  INSTALL_METHODS,
  KINDS,
  TAXONOMY,
  aliasesFor,
  allValues,
  facetableFamilies,
  family,
  familyByParam,
  isDomain,
  isInstallMethod,
  isKind,
  isValue,
  listSchema,
  paramFor,
  valueSchema,
  values,
} from './taxonomy';

/** These run against the real committed packages/core/taxonomy.yaml. */
describe('taxonomy accessors', () => {
  it('loads all eight families in declared order', () => {
    expect(TAXONOMY.map((f) => f.id)).toEqual([
      'kind',
      'domains',
      'runtime',
      'install_methods',
      'license_class',
      'openness',
      'maturity',
      'governance',
    ]);
  });

  it('throws on an unknown family', () => {
    expect(() => family('nope')).toThrow(/unknown family: nope/);
  });

  it('excludes hidden values from values() but not allValues()', () => {
    expect(values('openness').map((v) => v.id)).not.toContain('unknown');
    expect(allValues('openness').map((v) => v.id)).toContain('unknown');
  });

  it('maps aliases case-insensitively to value ids', () => {
    const domains = aliasesFor('domains');
    expect(domains.get('prometheus')).toBe('observability');
    expect(domains.get('Prometheus')).toBeUndefined(); // keys are lowercased; look up lowercased
    expect(aliasesFor('license_class').get('apache-2.0')).toBe('permissive');
  });

  it('distinguishes BSL-1.0 from BUSL-1.1', () => {
    const licences = aliasesFor('license_class');
    expect(licences.get('bsl-1.0')).toBe('permissive');
    expect(licences.get('busl-1.1')).toBe('source-available');
  });

  it('resolves params in both directions', () => {
    expect(paramFor('domains')).toBe('domain');
    expect(paramFor('install_methods')).toBe('install');
    expect(familyByParam('domain')?.id).toBe('domains');
    expect(familyByParam('nope')).toBeNull();
  });

  it('lists facetable families', () => {
    expect(facetableFamilies()).toContain('kind');
    expect(facetableFamilies()).toContain('governance');
  });

  it('keeps the legacy list exports working', () => {
    expect(KINDS).toContain('kubectl-plugin');
    expect(DOMAINS).toContain('database');
    expect(INSTALL_METHODS).toContain('krew');
    expect(isKind('operator')).toBe(true);
    expect(isKind('nope')).toBe(false);
    expect(isDomain('secrets')).toBe(true);
    expect(isInstallMethod('helm')).toBe(true);
    expect(isKind(FALLBACK_KIND)).toBe(true);
  });

  it('validates a single value with valueSchema', () => {
    expect(valueSchema('kind').parse('cli')).toBe('cli');
    expect(() => valueSchema('kind').parse('nope')).toThrow();
    // Hidden values are still valid data — they are only hidden from the UI.
    expect(valueSchema('openness').parse('unknown')).toBe('unknown');
  });

  it('applies the family min and max in listSchema', () => {
    expect(Domains.parse(['security'])).toEqual(['security']);
    expect(() => Domains.parse([])).toThrow();
    expect(() => Domains.parse(['security', 'policy', 'storage', 'cost'])).toThrow();
    // install_methods declares neither min nor max: unbounded, and empty is legal.
    expect(listSchema('install_methods').parse([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/core/src/taxonomy.test.ts
```

Expected: FAIL — no export named `TAXONOMY`.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `packages/core/src/taxonomy.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseTaxonomy, type TaxonomyFamily, type TaxonomyValue } from './taxonomy-schema';

/**
 * The closed vocabulary (AGENTS.md §6), loaded from `packages/core/taxonomy.yaml`.
 *
 * Two axes, never one: `kind` is what the artifact *is*, `domains` is what it solves.
 * Cilium is a controller AND networking; a flat category list cannot say that.
 *
 * The file is read once at module load and validated in full. A malformed taxonomy takes
 * every worker and the web app down immediately rather than letting them classify into a
 * vocabulary that does not exist.
 *
 * Because the vocabulary is data, `Kind` and friends are `string`, not literal unions. The
 * safety net that replaces compile-time checking is packages/analyze/src/rules/pinning.test.ts,
 * which asserts every value any rule can emit exists in this file.
 */
const FILENAME = 'taxonomy.yaml';

/**
 * Resolved relative to this module's own location, which is correct under plain Node ESM —
 * the workers, the Next dev server and vitest all resolve it this way.
 *
 * What is NOT verified: a bundler that rewrites `import.meta.url` would break this. Next's
 * `transpilePackages` covers `@keco/core`, and `next.config.ts` traces the YAML into a
 * standalone build, but the portal task is what proves the build actually finds it.
 *
 * An earlier draft also walked up to `pnpm-workspace.yaml` as a fallback. It was removed: it
 * resolved to the identical path in this repo, and in the one deployment it claimed to
 * protect — a traced standalone build — `pnpm-workspace.yaml` is not present at all, so it
 * could never fire. A fallback that looks like safety but never runs is worse than none,
 * because it stops people looking for the real fix.
 */
export const taxonomyPath = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', FILENAME);

function readTaxonomyFile(path = taxonomyPath()): string {
  if (!existsSync(path)) throw new Error(`taxonomy: ${FILENAME} not found at ${path}`);
  return readFileSync(path, 'utf8');
}

const FILE = parseTaxonomy(readTaxonomyFile());

/** Every family, in declared order. Plain data — safe to pass to a client component. */
export const TAXONOMY: TaxonomyFamily[] = FILE.families;

const BY_ID = new Map(TAXONOMY.map((f) => [f.id, f]));
const BY_PARAM = new Map(TAXONOMY.map((f) => [f.param, f]));

export function family(id: string): TaxonomyFamily {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`taxonomy: unknown family: ${id}`);
  return found;
}

export const familyByParam = (param: string): TaxonomyFamily | null => BY_PARAM.get(param) ?? null;
export const paramFor = (familyId: string): string => family(familyId).param;

/** Visible values — what the UI renders. */
export const values = (familyId: string): TaxonomyValue[] =>
  family(familyId).values.filter((value) => !value.hidden);

/** Every value including hidden ones — what validation accepts. */
export const allValues = (familyId: string): TaxonomyValue[] => family(familyId).values;

export const isValue = (familyId: string, id: string): boolean =>
  family(familyId).values.some((value) => value.id === id);

/** Lowercased external identifier → value id. Look up with `.toLowerCase()`. */
export function aliasesFor(familyId: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of family(familyId).values) {
    for (const alias of value.aliases) map.set(alias.toLowerCase(), value.id);
  }
  return map;
}

export const facetableFamilies = (): string[] =>
  TAXONOMY.filter((f) => f.facet).map((f) => f.id);

/** A single value of a family. Hidden values are valid data; they are only hidden from the UI. */
export const valueSchema = (familyId: string) =>
  z.string().refine((value) => isValue(familyId, value), {
    message: `expected one of the ${familyId} taxonomy values`,
  });

/** A list of values, honouring the family's declared min and max. */
export function listSchema(familyId: string) {
  const { min, max } = family(familyId);
  let schema = z.array(valueSchema(familyId));
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema;
}

// ── legacy surface, now derived from the file ────────────────────────────────

export const KINDS: string[] = allValues('kind').map((v) => v.id);
export const DOMAINS: string[] = allValues('domains').map((v) => v.id);
export const INSTALL_METHODS: string[] = allValues('install_methods').map((v) => v.id);

export const Kind = valueSchema('kind');
export const Domain = valueSchema('domains');
export const InstallMethod = valueSchema('install_methods');

export type Kind = string;
export type Domain = string;
export type InstallMethod = string;

/** Domains list constraint: min and max come from the file (§6). */
export const Domains = listSchema('domains');

/**
 * Fallback for an unclassifiable repo. The LLM pass falls back here rather than inventing
 * a kind — see §4.2 pass 3.
 */
export const FALLBACK_KIND: Kind = 'service';

export const isKind = (value: string): boolean => isValue('kind', value);
export const isDomain = (value: string): boolean => isValue('domains', value);
export const isInstallMethod = (value: string): boolean => isValue('install_methods', value);

export type { TaxonomyFamily, TaxonomyValue };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run packages/core/src/taxonomy.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Export the schema module from the package**

Edit `packages/core/src/index.ts` — add the schema module so `parseTaxonomy` is importable by the validator binary in Task 12:

```ts
export * from './taxonomy';
export * from './taxonomy-schema';
export * from './events';
export * from './schemas';
export * as scoring from './scoring';
```

Then check for a name clash:

```bash
pnpm -F @keco/core check
```

Expected: PASS with no output. (`taxonomy.ts` re-exports the `TaxonomyFamily` and `TaxonomyValue` *types* while `taxonomy-schema.ts` exports the same type names plus the `*Schema` consts; TypeScript tolerates the duplicate type re-export because both resolve to the same declaration. If it errors, remove the `export type { TaxonomyFamily, TaxonomyValue };` line at the bottom of `taxonomy.ts` — `index.ts` already re-exports them from `taxonomy-schema`.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/taxonomy.ts packages/core/src/taxonomy.test.ts packages/core/src/index.ts
git commit -m "feat(core): load the taxonomy from YAML at module init"
```

---

## Task 4: Schemas — new fields and the github_topics rename

**Files:**
- Modify: `packages/core/src/schemas.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AnalysisSchema, ToolDocument } from './schemas';

const analysis = {
  repo: 'cert-manager/cert-manager',
  content_hash: 'abc123',
  summary: 'TLS certificate management for Kubernetes.',
  kind: 'operator',
  domains: ['security'],
  k8s_relevance: 0.9,
  confidence: 0.95,
  signals: { scorecard: null, osv: null, dependents: null },
  method: 'rules',
  analyzed_at: '2026-08-01T00:00:00.000Z',
};

describe('AnalysisSchema', () => {
  it('defaults every derived family to unknown', () => {
    const parsed = AnalysisSchema.parse(analysis);
    expect(parsed.runtime).toBe('unknown');
    expect(parsed.license_class).toBe('unknown');
    expect(parsed.openness).toBe('unknown');
    expect(parsed.maturity).toBe('unknown');
    expect(parsed.governance).toBe('unknown');
  });

  it('accepts values declared in the taxonomy', () => {
    const parsed = AnalysisSchema.parse({ ...analysis, runtime: 'in-cluster', maturity: 'cncf-graduated' });
    expect(parsed.runtime).toBe('in-cluster');
    expect(parsed.maturity).toBe('cncf-graduated');
  });

  it('rejects a value absent from the taxonomy', () => {
    expect(() => AnalysisSchema.parse({ ...analysis, runtime: 'in-the-cloud' })).toThrow();
    expect(() => AnalysisSchema.parse({ ...analysis, kind: 'wasm-module' })).toThrow();
  });

  it('rejects more than three domains', () => {
    expect(() =>
      AnalysisSchema.parse({ ...analysis, domains: ['security', 'policy', 'storage', 'cost'] }),
    ).toThrow();
  });
});

describe('ToolDocument', () => {
  it('carries github_topics, not topics', () => {
    const shape = ToolDocument.shape;
    expect(shape).toHaveProperty('github_topics');
    expect(shape).not.toHaveProperty('topics');
  });

  it('requires the five new family fields', () => {
    for (const field of ['runtime', 'license_class', 'openness', 'maturity', 'governance']) {
      expect(ToolDocument.shape).toHaveProperty(field);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/core/src/schemas.test.ts
```

Expected: FAIL — `parsed.runtime` is `undefined`.

- [ ] **Step 3: Update the imports and the two schemas**

In `packages/core/src/schemas.ts`, replace the import on line 2:

```ts
import { Domains, InstallMethod, Kind, valueSchema } from './taxonomy';
```

In `AnalysisSchema`, insert the five family fields immediately after the `domains` line:

```ts
  kind: Kind,
  domains: Domains,
  /** Where the thing executes. `unknown` until a rule proves otherwise (§6). */
  runtime: valueSchema('runtime').default('unknown'),
  /** Licence family bucketed from the SPDX id GitHub reports. */
  license_class: valueSchema('license_class').default('unknown'),
  /** Fully open vs open-core. Promoted only on positive evidence — see docs/taxonomy.md. */
  openness: valueSchema('openness').default('unknown'),
  maturity: valueSchema('maturity').default('unknown'),
  governance: valueSchema('governance').default('unknown'),
```

In `ToolDocument`, rename `topics` on line 91:

```ts
  /** GitHub's own topics, verbatim. Not Keco's taxonomy — that is the five fields below. */
  github_topics: z.array(z.string()),
```

and insert the five family fields immediately after the `domains` line in `ToolDocument` (these are required here, not defaulted — the projector always writes them):

```ts
  kind: Kind,
  domains: Domains,
  runtime: valueSchema('runtime'),
  license_class: valueSchema('license_class'),
  openness: valueSchema('openness'),
  maturity: valueSchema('maturity'),
  governance: valueSchema('governance'),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run packages/core/src/schemas.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck the workspace**

```bash
pnpm -r --parallel check
```

Expected: PASS. If `packages/analyze/src/llm.ts` errors, it is because `fallbackAnalysis` builds an `Analysis` literal — it does not set the new fields, but they all have defaults, so `AnalysisSchema.parse` fills them and the return type still matches. No change should be needed there.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/src/schemas.test.ts
git commit -m "feat(core): add runtime, license_class, openness, maturity, governance; rename topics to github_topics"
```

---

## Task 5: Domain classification reads aliases from the file

**Files:**
- Modify: `packages/analyze/src/rules/kind.ts:148-201`

- [ ] **Step 1: Delete the hard-coded map and rewrite classifyDomains**

In `packages/analyze/src/rules/kind.ts`, delete the entire `DOMAIN_TOPICS` constant (lines 148-191) and replace `classifyDomains` (lines 193-201) with:

```ts
/**
 * Domains from GitHub topics, mapped through the `aliases` declared in taxonomy.yaml.
 * Adding a topic mapping is a data edit, not a code change (§6).
 */
export function classifyDomains(input: RuleInput): Domain[] {
  const aliases = aliasesFor('domains');
  const max = family('domains').max ?? 3;
  const found = new Set<Domain>();
  for (const topic of input.topics) {
    const domain = aliases.get(topic.toLowerCase());
    if (domain) found.add(domain);
  }
  return [...found].slice(0, max);
}
```

Update the import on line 1 of the same file:

```ts
import { aliasesFor, family, type Domain, type Kind } from '@keco/core';
```

- [ ] **Step 2: Run the existing fixture tests to verify no regression**

```bash
pnpm vitest run packages/analyze
```

Expected: PASS. The four fixtures expect `[]`, `["security"]`, `[]`, `["packaging","observability"]` — every alias behind those came across into the YAML in Task 2. If one fails, an alias was dropped from `taxonomy.yaml`; fix the YAML, not the fixture.

- [ ] **Step 3: Commit**

```bash
git add packages/analyze/src/rules/kind.ts
git commit -m "refactor(analyzer): read domain aliases from taxonomy.yaml"
```

---

## Task 6: Runtime classification

**Files:**
- Create: `packages/analyze/src/rules/runtime.ts`
- Modify: `packages/analyze/src/index.ts`
- Test: covered by Task 7's `fixtures.test.ts`; this task adds targeted unit tests inline

- [ ] **Step 1: Write the failing test**

Create `packages/analyze/src/rules/runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RuleInput } from './kind';
import { classifyRuntime } from './runtime';

const base: RuleInput = {
  repo: 'acme/thing',
  name: 'thing',
  description: null,
  topics: [],
  tree: ['README.md'],
  manifests: {},
  language: 'Go',
};

describe('classifyRuntime', () => {
  it('calls a distribution the cluster itself', () => {
    expect(classifyRuntime(base, 'distribution').runtime).toBe('cluster-itself');
  });

  it('puts a krew plugin on the workstation even when it also ships a chart', () => {
    const input = { ...base, tree: ['.krew.yaml', 'charts/thing/Chart.yaml'] };
    expect(classifyRuntime(input, 'kubectl-plugin').runtime).toBe('workstation');
  });

  it('puts a chart in the cluster', () => {
    expect(classifyRuntime({ ...base, tree: ['Chart.yaml'] }, 'helm-chart').runtime).toBe('in-cluster');
  });

  it('puts CRDs in the cluster', () => {
    const input = { ...base, tree: ['config/crd/bases/x.yaml', 'PROJECT'] };
    expect(classifyRuntime(input, 'operator').runtime).toBe('in-cluster');
  });

  it('recognises a GitHub Action as a pipeline step', () => {
    expect(classifyRuntime({ ...base, tree: ['action.yml'] }, null).runtime).toBe('ci-pipeline');
  });

  it('does not mistake a workflow file for an action', () => {
    const input = { ...base, tree: ['.github/workflows/ci.yml'] };
    expect(classifyRuntime(input, null).runtime).toBe('unknown');
  });

  it('recognises a library with no command', () => {
    const input = { ...base, manifests: { 'go.mod': 'require k8s.io/client-go v0.29.0' } };
    expect(classifyRuntime(input, 'library-sdk').runtime).toBe('in-your-code');
  });

  it('falls back to in-cluster for an in-cluster kind with no structural evidence', () => {
    expect(classifyRuntime(base, 'controller').runtime).toBe('in-cluster');
  });

  it('returns unknown with zero confidence when nothing fires', () => {
    const verdict = classifyRuntime(base, null);
    expect(verdict.runtime).toBe('unknown');
    expect(verdict.confidence).toBe(0);
    expect(verdict.rule).toBe('none');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/analyze/src/rules/runtime.test.ts
```

Expected: FAIL — `Failed to resolve import "./runtime"`.

- [ ] **Step 3: Write the implementation**

Create `packages/analyze/src/rules/runtime.ts`:

```ts
import type { RuleInput } from './kind';

/**
 * Pass 1 — the `runtime` family (AGENTS.md §4.2, §6). Where the thing actually executes,
 * which is orthogonal to what it is: cert-manager is a `controller` that runs `in-cluster`,
 * k9s is a `cli` that runs on your `workstation`.
 *
 * Structural evidence first, then the kind as a weaker fallback, then `unknown`. Never
 * guess: an unclassifiable repo is `unknown`, not a plausible-looking default.
 */
export type RuntimeVerdict = {
  runtime: string;
  confidence: number;
  /** Which rule fired, for the analysis document's rules trace. */
  rule: string;
};

/** Every runtime this module can emit. Asserted against taxonomy.yaml by pinning.test.ts. */
export const DECLARED_RUNTIMES = [
  'cluster-itself',
  'workstation',
  'in-cluster',
  'ci-pipeline',
  'in-your-code',
  'unknown',
] as const;

const has = (tree: string[], predicate: (path: string) => boolean) => tree.some(predicate);

const isChartYaml = (path: string) =>
  path === 'Chart.yaml' || /(^|\/)charts\/[^/]+\/Chart\.yaml$/.test(path);

/** A root `action.yml` is a GitHub Action. A file under .github/workflows is not — that is CI *for* the repo. */
const isActionManifest = (path: string) => path === 'action.yml' || path === 'action.yaml';

const LIBRARY_MANIFEST = [
  { file: 'go.mod', pattern: /k8s\.io\/client-go|sigs\.k8s\.io\/controller-runtime/ },
  { file: 'package.json', pattern: /@kubernetes\/client-node/ },
  { file: 'Cargo.toml', pattern: /^kube\s*=/m },
];

/**
 * Kind-only fallbacks, used when no structural evidence fired. Their confidence must stay
 * BELOW every structural rule (0.7+): a guess from the kind alone is weaker than a file on
 * disk, and the numbers have to say so.
 *
 * Two kinds are deliberately absent from the in-cluster set:
 *   - `service` is FALLBACK_KIND, what the LLM assigns when it could not classify the repo
 *     at all. Turning "we don't know what this is" into "it runs in-cluster" is exactly the
 *     guess this module forbids, and at corpus scale it is a silent bias.
 *   - `dashboard-ui` spans both runtimes — Lens and k9s run on your workstation, Kubernetes
 *     Dashboard and Headlamp run in-cluster — and nothing here can tell them apart.
 * Both fall through to `unknown`.
 */
const WORKSTATION_KINDS = new Set(['cli', 'kubectl-plugin', 'ide-extension']);
const IN_CLUSTER_KINDS = new Set(['operator', 'controller', 'admission-webhook', 'helm-chart']);

/**
 * Ordered strongest-first. `kind` is the winning verdict from `classifyKind`, or null when
 * pass 1 could not decide.
 */
export function classifyRuntime(input: RuleInput, kind: string | null): RuntimeVerdict {
  if (kind === 'distribution') {
    return { runtime: 'cluster-itself', confidence: 0.9, rule: 'kind:distribution' };
  }

  // A krew manifest is a fact about how the binary is invoked; a chart in the same repo is
  // usually there to deploy something else. The plugin wins.
  if (has(input.tree, (p) => p === '.krew.yaml' || p.endsWith('/.krew.yaml'))) {
    return { runtime: 'workstation', confidence: 0.9, rule: 'tree:.krew.yaml' };
  }
  if (kind !== null && WORKSTATION_KINDS.has(kind)) {
    return { runtime: 'workstation', confidence: 0.65, rule: `kind:${kind}` };
  }

  if (has(input.tree, (p) => isChartYaml(p) || p.startsWith('config/crd/'))) {
    return { runtime: 'in-cluster', confidence: 0.85, rule: 'tree:chart-or-crd' };
  }

  if (has(input.tree, isActionManifest)) {
    return { runtime: 'ci-pipeline', confidence: 0.8, rule: 'tree:action.yml' };
  }

  const isLibrary = LIBRARY_MANIFEST.some(({ file, pattern }) =>
    pattern.test(input.manifests[file] ?? ''),
  );
  if (isLibrary && !has(input.tree, (p) => p.startsWith('cmd/'))) {
    return { runtime: 'in-your-code', confidence: 0.7, rule: 'manifest:library without cmd' };
  }

  if (kind !== null && IN_CLUSTER_KINDS.has(kind)) {
    return { runtime: 'in-cluster', confidence: 0.6, rule: `kind:${kind}` };
  }

  return { runtime: 'unknown', confidence: 0, rule: 'none' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run packages/analyze/src/rules/runtime.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Export it from the package**

Edit `packages/analyze/src/index.ts`:

```ts
export * from './rules/kind';
export * from './rules/runtime';
export * from './llm';
```

- [ ] **Step 6: Commit**

```bash
git add packages/analyze/src/rules/runtime.ts packages/analyze/src/rules/runtime.test.ts packages/analyze/src/index.ts
git commit -m "feat(analyzer): classify the runtime family from structural evidence"
```

---

## Task 7: Derived classification

**Files:**
- Create: `packages/analyze/src/rules/derived.ts`
- Test: `packages/analyze/src/rules/derived.test.ts`
- Modify: `packages/analyze/src/index.ts`

Note the deviation recorded at the top of this plan: `governance` uses landscape evidence and the GitHub account type only. There is no contributor heuristic and no `contributors` field.

`landscape` is the lookup into the CNCF landscape seed the crawler will cache. The crawler is not implemented, so in practice every caller passes `null` today and `maturity`/`governance` degrade to age, activity and account type. That is the designed behaviour, not a stopgap — the rule must produce the same answer whether the seed is absent or the repo simply is not listed.

- [ ] **Step 1: Write the failing test**

Create `packages/analyze/src/rules/derived.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/analyze/src/rules/derived.test.ts
```

Expected: FAIL — `Failed to resolve import "./derived"`.

- [ ] **Step 3: Write the implementation**

Create `packages/analyze/src/rules/derived.ts`:

```ts
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

/**
 * A root directory that exists to hold the paid edition. Root-anchored deliberately:
 * loosening it to any path segment was checked against Vault, Istio and Kong and found zero
 * additional hits, while `docs/enterprise/` and vendored paths would start matching. The
 * dominant real miss — Grafana — keeps Enterprise in a separate private repo with no
 * footprint in the public tree, which no path pattern can catch. `pro` was dropped: no repo
 * checked used it for a commercial edition, and it collides far more readily than `ee`.
 */
const ENTERPRISE_PATH = /^(ee|enterprise)\//;
const ENTERPRISE_README =
  /enterprise edition|enterprise version|business edition|commercial license|commercial edition/i;

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
  // `archived` is checked first, and beats a CNCF level. LandscapeEntry has no retired
  // state and a cached seed can lag CNCF's own retirement bookkeeping, so the other order
  // reports `cncf-incubating` for projects GitHub already marks archived — opentracing-go
  // and rkt are both exactly that. Archived is the strongest evidence a project is not
  // alive, and it comes from GitHub rather than a cache that can drift.
  if (input.archived) return 'archived';
  if (input.landscape?.cncf_level) return `cncf-${input.landscape.cncf_level}`;
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run packages/analyze/src/rules/derived.test.ts
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Export it from the package**

Edit `packages/analyze/src/index.ts`:

```ts
export * from './rules/kind';
export * from './rules/runtime';
export * from './rules/derived';
export * from './llm';
```

- [ ] **Step 6: Commit**

```bash
git add packages/analyze/src/rules/derived.ts packages/analyze/src/rules/derived.test.ts packages/analyze/src/index.ts
git commit -m "feat(analyzer): derive license_class, openness, maturity and governance from cached metadata"
```

---

## Task 8: Fixtures and the pinning test

**Files:**
- Modify: `packages/analyze/fixtures/ahmetb__kubectx.json`, `cert-manager__cert-manager.json`, `dennyzhang__cheatsheet-kubernetes.json`, `prometheus-community__helm-charts.json`
- Create: `packages/analyze/fixtures/_synthetic__open-core.json`, `packages/analyze/fixtures/_synthetic__source-available.json`
- Create: `packages/analyze/src/rules/fixtures.test.ts`
- Delete: `packages/analyze/src/rules/kind.test.ts`
- Create: `packages/analyze/src/rules/pinning.test.ts`

§13 requires a fixture per new rule. Two combinations — an open-core repo and a source-available licence — do not exist in the four real fixtures. Rather than assert a licence for a real project from memory (a fixture is a cache entry; putting a wrong licence in one would be exactly the kind of false claim this system must not make), the two new fixtures are explicitly synthetic and marked as such.

- [ ] **Step 1: Extend the four existing fixtures**

Add a `derived_input` block and `runtime`/`derived` expectations to each. Add to `packages/analyze/fixtures/ahmetb__kubectx.json` — insert `derived_input` before `expected`, and extend `expected`:

```json
  "derived_input": {
    "owner": "ahmetb",
    "owner_type": "User",
    "license_spdx": "Apache-2.0",
    "readme": "# kubectx + kubens\n\nFaster way to switch between clusters and namespaces in kubectl.",
    "archived": false,
    "created_at": "2017-06-12T00:00:00.000Z",
    "pushed_at": "2026-06-15T00:00:00.000Z",
    "latest_release_at": "2026-04-01T00:00:00.000Z",
    "landscape": null
  },
  "expected": {
    "kind": "kubectl-plugin",
    "rule": "tree:.krew.yaml",
    "domains": [],
    "k8s_relevance_min": 0.7,
    "runtime": "workstation",
    "derived": {
      "license_class": "permissive",
      "openness": "fully-open",
      "maturity": "established",
      "governance": "individual"
    }
  }
```

`packages/analyze/fixtures/cert-manager__cert-manager.json`:

```json
  "derived_input": {
    "owner": "cert-manager",
    "owner_type": "Organization",
    "license_spdx": "Apache-2.0",
    "readme": "# cert-manager\n\ncert-manager adds certificates and certificate issuers as resource types in Kubernetes clusters.",
    "archived": false,
    "created_at": "2017-10-12T00:00:00.000Z",
    "pushed_at": "2026-07-20T00:00:00.000Z",
    "latest_release_at": "2026-06-01T00:00:00.000Z",
    "landscape": { "cncf_level": "graduated", "org_type": "foundation" }
  },
  "expected": {
    "kind": "operator",
    "rule": "tree:config/crd+PROJECT (kubebuilder)",
    "domains": ["security"],
    "k8s_relevance_min": 0.8,
    "runtime": "in-cluster",
    "derived": {
      "license_class": "permissive",
      "openness": "fully-open",
      "maturity": "cncf-graduated",
      "governance": "foundation"
    }
  }
```

`packages/analyze/fixtures/dennyzhang__cheatsheet-kubernetes.json`:

```json
  "derived_input": {
    "owner": "dennyzhang",
    "owner_type": "User",
    "license_spdx": null,
    "readme": "# Kubernetes CheatSheet\n\nCheatsheets in A4 format.",
    "archived": false,
    "created_at": "2018-05-01T00:00:00.000Z",
    "pushed_at": "2021-01-01T00:00:00.000Z",
    "latest_release_at": null,
    "landscape": null
  },
  "expected": {
    "kind": "learning-resource",
    "rule": "topic:learning",
    "domains": [],
    "note": "Mentions Kubernetes everywhere but is not an ecosystem tool — kept in cache, demoted by k8s_relevance at projection time (§14).",
    "runtime": "unknown",
    "derived": {
      "license_class": "unknown",
      "openness": "unknown",
      "maturity": "dormant",
      "governance": "individual"
    }
  }
```

`packages/analyze/fixtures/prometheus-community__helm-charts.json`:

```json
  "derived_input": {
    "owner": "prometheus-community",
    "owner_type": "Organization",
    "license_spdx": "Apache-2.0",
    "readme": "# Prometheus Community Kubernetes Helm Charts\n\nUsage instructions for the charts in this repository.",
    "archived": false,
    "created_at": "2020-04-01T00:00:00.000Z",
    "pushed_at": "2026-07-25T00:00:00.000Z",
    "latest_release_at": "2026-07-20T00:00:00.000Z",
    "landscape": null
  },
  "expected": {
    "kind": "helm-chart",
    "rule": "tree:Chart.yaml",
    "domains": ["packaging", "observability"],
    "k8s_relevance_min": 0.5,
    "runtime": "in-cluster",
    "derived": {
      "license_class": "permissive",
      "openness": "fully-open",
      "maturity": "established",
      "governance": "unknown"
    }
  }
```

- [ ] **Step 2: Create the two synthetic fixtures**

Create `packages/analyze/fixtures/_synthetic__open-core.json`:

```json
{
  "synthetic": true,
  "note": "Not a real repository. Encodes the open-core combination — an OSI licence alongside an enterprise directory and a commercial edition in the README — which no real fixture in this directory carries yet. Replace it with a real cache entry once the crawler has one.",
  "repo": "example/synthetic-open-core",
  "name": "synthetic-operator",
  "description": "A synthetic operator with a paid edition",
  "topics": ["kubernetes", "kubernetes-operator", "database"],
  "language": "Go",
  "tree": [
    "README.md",
    "PROJECT",
    "config/crd/bases/example.io_widgets.yaml",
    "enterprise/licensing.go",
    "go.mod"
  ],
  "manifests": {
    "go.mod": "module example.io/synthetic\n\ngo 1.22\n\nrequire (\n\tsigs.k8s.io/controller-runtime v0.17.0\n)\n"
  },
  "derived_input": {
    "owner": "example",
    "owner_type": "Organization",
    "license_spdx": "AGPL-3.0",
    "readme": "# synthetic-operator\n\nThe open source edition. See the Enterprise Edition for SSO and audit logs.",
    "archived": false,
    "created_at": "2021-02-01T00:00:00.000Z",
    "pushed_at": "2026-07-01T00:00:00.000Z",
    "latest_release_at": "2026-05-01T00:00:00.000Z",
    "landscape": { "cncf_level": null, "org_type": "vendor" }
  },
  "expected": {
    "kind": "operator",
    "rule": "tree:config/crd+PROJECT (kubebuilder)",
    "domains": ["database"],
    "runtime": "in-cluster",
    "derived": {
      "license_class": "copyleft",
      "openness": "open-core",
      "maturity": "established",
      "governance": "vendor-backed"
    }
  }
}
```

Create `packages/analyze/fixtures/_synthetic__source-available.json`:

```json
{
  "synthetic": true,
  "note": "Not a real repository. Encodes a Business Source Licence, which no real fixture in this directory carries yet, and pins the BSL-1.0 / BUSL-1.1 distinction end to end.",
  "repo": "example/terraform-provider-synthetic",
  "name": "terraform-provider-synthetic",
  "description": "A synthetic Terraform provider under a source-available licence",
  "topics": ["kubernetes", "terraform"],
  "language": "Go",
  "tree": ["README.md", "main.go", "go.mod"],
  "manifests": {
    "go.mod": "module example.io/terraform-provider-synthetic\n\ngo 1.22\n"
  },
  "derived_input": {
    "owner": "example",
    "owner_type": "Organization",
    "license_spdx": "BUSL-1.1",
    "readme": "# terraform-provider-synthetic\n\nManage synthetic resources from Terraform.",
    "archived": false,
    "created_at": "2019-03-01T00:00:00.000Z",
    "pushed_at": "2026-07-10T00:00:00.000Z",
    "latest_release_at": "2026-07-01T00:00:00.000Z",
    "landscape": null
  },
  "expected": {
    "kind": "terraform-provider",
    "rule": "manifest:terraform-provider",
    "domains": [],
    "runtime": "unknown",
    "derived": {
      "license_class": "source-available",
      "openness": "source-available",
      "maturity": "established",
      "governance": "unknown"
    }
  }
}
```

- [ ] **Step 3: Replace kind.test.ts with a suite covering all three classifiers**

Delete the old file and create `packages/analyze/src/rules/fixtures.test.ts`:

```bash
git rm packages/analyze/src/rules/kind.test.ts
```

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDerived, type DerivedInput } from './derived';
import { classifyDomains, classifyKind, k8sRelevance, type RuleInput } from './kind';
import { classifyRuntime } from './runtime';

/**
 * Fixtures are literally cache entries (§13) — real cached payloads, committed. A new
 * classification rule requires a fixture proving it, and this suite runs every fixture
 * through every pass-1 classifier.
 *
 * Two fixtures are marked `synthetic`: they encode a licence and marker combination the
 * real corpus does not yet contain. They are named `_synthetic__*` so it is obvious in a
 * directory listing which entries are not real cache.
 */
type Fixture = RuleInput & {
  synthetic?: boolean;
  derived_input?: DerivedInput;
  expected: {
    kind: string;
    rule: string;
    domains?: string[];
    k8s_relevance_min?: number;
    runtime?: string;
    derived?: {
      license_class: string;
      openness: string;
      maturity: string;
      governance: string;
    };
  };
};

/** Fixed so the maturity expectations above are deterministic. */
const NOW = new Date('2026-08-01T00:00:00.000Z');

const FIXTURE_DIR = new URL('../../fixtures/', import.meta.url).pathname;

const fixtures = await Promise.all(
  (await readdir(FIXTURE_DIR))
    .filter((file) => file.endsWith('.json'))
    .map(async (file) => JSON.parse(await readFile(join(FIXTURE_DIR, file), 'utf8')) as Fixture),
);

describe('pass 1 — local rules', () => {
  it('has at least one fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('has at least one real, non-synthetic fixture', () => {
    expect(fixtures.some((fixture) => fixture.synthetic !== true)).toBe(true);
  });

  for (const fixture of fixtures) {
    describe(fixture.repo, () => {
      const verdicts = classifyKind(fixture);
      const kind = verdicts[0]?.kind ?? null;

      it(`classifies as ${fixture.expected.kind} via ${fixture.expected.rule}`, () => {
        expect(verdicts[0]?.kind).toBe(fixture.expected.kind);
        expect(verdicts[0]?.rule).toBe(fixture.expected.rule);
      });

      if (fixture.expected.domains) {
        it('derives the expected domains from topics', () => {
          expect(classifyDomains(fixture).sort()).toEqual([...fixture.expected.domains!].sort());
        });
      }

      if (fixture.expected.k8s_relevance_min !== undefined) {
        it('is recognisably part of the Kubernetes ecosystem', () => {
          expect(k8sRelevance(fixture)).toBeGreaterThanOrEqual(fixture.expected.k8s_relevance_min!);
        });
      }

      if (fixture.expected.runtime) {
        it(`runs ${fixture.expected.runtime}`, () => {
          expect(classifyRuntime(fixture, kind).runtime).toBe(fixture.expected.runtime);
        });
      }

      if (fixture.expected.derived) {
        it('derives licence, openness, maturity and governance', () => {
          expect(fixture.derived_input).toBeDefined();
          expect(classifyDerived(fixture.derived_input!, NOW)).toEqual(fixture.expected.derived);
        });
      }
    });
  }
});

describe('k8sRelevance', () => {
  it('demotes a repo whose only Kubernetes link is a CI manifest', () => {
    const dotfiles: RuleInput = {
      repo: 'someone/dotfiles',
      name: 'dotfiles',
      description: 'my shell config',
      topics: ['zsh', 'dotfiles'],
      tree: ['README.md', '.github/workflows/kubernetes-deploy.yml'],
      manifests: {},
      language: 'Shell',
    };
    expect(k8sRelevance(dotfiles)).toBe(0);
  });
});
```

- [ ] **Step 4: Write the pinning test**

Create `packages/analyze/src/rules/pinning.test.ts`:

```ts
import { FALLBACK_KIND, allValues, isValue } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { DECLARED_DERIVED } from './derived';
import { DECLARED_KINDS } from './kind';
import { DECLARED_RUNTIMES } from './runtime';

/**
 * The safety net that replaces the compile-time union check (§6, and the design note in
 * docs/superpowers/specs/2026-08-01-taxonomy-yaml-design.md).
 *
 * The vocabulary is data now, so a typo in a rule table is no longer a type error. It is a
 * document nothing can filter on and a chip that never appears. This suite makes it a test
 * failure instead.
 *
 * `kind`, `domains` and `runtime` are checked one way only — declared values must exist in
 * the file, but the file may legitimately hold values no pass-1 rule emits, because pass 3
 * (the LLM) can produce them. The derived families are checked both ways: every value in
 * the file must be reachable, since nothing but these rules ever assigns them.
 */
describe('rule outputs are pinned to taxonomy.yaml', () => {
  it('every kind a rule can emit exists in the file', () => {
    for (const kind of DECLARED_KINDS) {
      expect(isValue('kind', kind), `kind rules emit "${kind}"`).toBe(true);
    }
  });

  it('the LLM fallback kind exists in the file', () => {
    expect(isValue('kind', FALLBACK_KIND)).toBe(true);
  });

  it('every runtime a rule can emit exists in the file', () => {
    for (const runtime of DECLARED_RUNTIMES) {
      expect(isValue('runtime', runtime), `runtime rules emit "${runtime}"`).toBe(true);
    }
  });

  for (const [familyId, declared] of Object.entries(DECLARED_DERIVED)) {
    it(`${familyId} declares exactly the values in the file`, () => {
      expect([...declared].sort()).toEqual(allValues(familyId).map((value) => value.id).sort());
    });
  }
});
```

- [ ] **Step 5: Export DECLARED_KINDS from the kind rules**

Add to `packages/analyze/src/rules/kind.ts`, immediately after the `KIND_RULES` constant:

```ts
/** Every kind a pass-1 rule can emit. Asserted against taxonomy.yaml by pinning.test.ts. */
export const DECLARED_KINDS: string[] = [...new Set(KIND_RULES.map((rule) => rule.kind))];
```

- [ ] **Step 6: Run the analyze suite**

```bash
pnpm vitest run packages/analyze
```

Expected: PASS. Every fixture's kind, domains, runtime and derived block matches, and the pinning test is green.

If the `dennyzhang` fixture fails on `governance`, check `owner_type` is `"User"`. If `prometheus-community` fails on `maturity`, check `created_at` — it must be more than two years before `2026-08-01`.

- [ ] **Step 7: Commit**

```bash
git add packages/analyze/fixtures packages/analyze/src/rules
git commit -m "test(analyzer): fixtures and pinning test for runtime and derived families"
```

---

## Task 9: Meilisearch settings

**Files:**
- Modify: `packages/search/src/settings.ts:11-43`

- [ ] **Step 1: Derive the filterable attributes from the taxonomy**

Replace the `TOOLS_SETTINGS` constant in `packages/search/src/settings.ts` with:

```ts
/**
 * Attributes Meilisearch filters on that are not taxonomy families: raw repository facts
 * and the numeric gates the query layer applies.
 */
const NON_TAXONOMY_FILTERABLE = [
  'language',
  'license',
  'archived',
  'stars',
  'has_release',
  'k8s_relevance',
  'has_scorecard',
  'owner',
];

/**
 * One filterable attribute per taxonomy family, derived from the file so that adding a
 * family is a YAML edit plus a rebuild — never an edit here that someone forgets (§5, §6).
 * `install_methods` is an array of objects, so it filters on the nested `.method`.
 */
export const familyAttribute = (familyId: string): string =>
  familyId === 'install_methods' ? 'install_methods.method' : familyId;

export const TOOLS_SETTINGS: Settings = {
  // Weight order matters: a name match must outrank a README mention.
  searchableAttributes: [
    'name',
    'full_name',
    'summary',
    'description',
    'github_topics',
    'readme_excerpt',
  ],
  filterableAttributes: [
    ...TAXONOMY.map((family) => familyAttribute(family.id)),
    ...NON_TAXONOMY_FILTERABLE,
  ],
  sortableAttributes: ['stars', 'score.total', 'score.momentum', 'pushed_at'],
  // Default ranking rules, then health as the tie-breaker — relevance first, always.
  rankingRules: [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness',
    'score.total:desc',
  ],
  // The default 1000 caps deep paging; raised deliberately (§5).
  pagination: { maxTotalHits: 10_000 },
  faceting: { maxValuesPerFacet: 200 },
  displayedAttributes: ['*'],
  typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
};
```

Add the import at the top of the file:

```ts
import { TAXONOMY } from '@keco/core';
import type { Settings } from 'meilisearch';
```

- [ ] **Step 2: Write the test**

Create `packages/search/src/settings.test.ts`:

```ts
import { TAXONOMY } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { TOOLS_SETTINGS, familyAttribute } from './settings';

describe('TOOLS_SETTINGS', () => {
  it('makes every taxonomy family filterable', () => {
    for (const family of TAXONOMY) {
      expect(TOOLS_SETTINGS.filterableAttributes).toContain(familyAttribute(family.id));
    }
  });

  it('nests the install method attribute', () => {
    expect(familyAttribute('install_methods')).toBe('install_methods.method');
    expect(familyAttribute('kind')).toBe('kind');
  });

  it('searches github_topics, not topics', () => {
    expect(TOOLS_SETTINGS.searchableAttributes).toContain('github_topics');
    expect(TOOLS_SETTINGS.searchableAttributes).not.toContain('topics');
  });
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm vitest run packages/search
```

Expected: PASS, 3 tests.

- [ ] **Step 4: Commit**

```bash
git add packages/search/src/settings.ts packages/search/src/settings.test.ts
git commit -m "feat(search): derive filterable attributes from the taxonomy"
```

---

## Task 10: The query filter builder

**Files:**
- Create: `packages/query/src/filters.ts`
- Test: `packages/query/src/filters.test.ts`
- Modify: `packages/query/src/index.ts`

`SearchParams` loses its per-family fields (`kind`, `domains`, `install`) in favour of one generic `filters` record keyed by family id, so a new family needs no code here. `language` and `license` stay named: they are repository facts, not taxonomy families.

- [ ] **Step 1: Write the failing test**

Create `packages/query/src/filters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildFilters, defaultFacets, selectionFromParams } from './filters';

describe('buildFilters', () => {
  it('always excludes archived tools and gates on relevance', () => {
    expect(buildFilters({})).toEqual(['archived = false', 'k8s_relevance >= 0.4']);
  });

  it('includes archived tools when asked', () => {
    expect(buildFilters({ includeArchived: true })).toEqual(['k8s_relevance >= 0.4']);
  });

  it('honours a custom relevance floor', () => {
    expect(buildFilters({ minRelevance: 0 })).toContain('k8s_relevance >= 0');
  });

  it('emits one IN clause per selected family', () => {
    const filters = buildFilters({ filters: { kind: ['cli'], domains: ['security', 'policy'] } });
    expect(filters).toContain('kind IN ["cli"]');
    expect(filters).toContain('domains IN ["security", "policy"]');
  });

  it('nests the install method attribute', () => {
    expect(buildFilters({ filters: { install_methods: ['krew'] } })).toContain(
      'install_methods.method IN ["krew"]',
    );
  });

  it('ignores an empty selection', () => {
    expect(buildFilters({ filters: { kind: [] } })).not.toContainEqual(expect.stringContaining('kind IN'));
  });

  it('ignores a family that is not in the taxonomy', () => {
    expect(buildFilters({ filters: { nonsense: ['x'] } })).not.toContainEqual(
      expect.stringContaining('nonsense'),
    );
  });

  it('filters on language and license, which are not families', () => {
    const filters = buildFilters({ language: ['Go'], license: ['Apache-2.0'] });
    expect(filters).toContain('language IN ["Go"]');
    expect(filters).toContain('license IN ["Apache-2.0"]');
  });
});

describe('defaultFacets', () => {
  it('asks for every facetable family', () => {
    expect(defaultFacets()).toContain('kind');
    expect(defaultFacets()).toContain('install_methods.method');
    expect(defaultFacets()).toContain('governance');
  });
});

describe('selectionFromParams', () => {
  it('reads each family from its declared URL parameter', () => {
    const selection = selectionFromParams({ domain: 'security,policy', kind: 'cli', install: 'krew' });
    expect(selection).toEqual({ domains: ['security', 'policy'], kind: ['cli'], install_methods: ['krew'] });
  });

  it('accepts repeated parameters as arrays', () => {
    expect(selectionFromParams({ domain: ['security', 'policy'] })).toEqual({
      domains: ['security', 'policy'],
    });
  });

  it('drops values that are not in the taxonomy', () => {
    expect(selectionFromParams({ kind: 'cli,wasm-module' })).toEqual({ kind: ['cli'] });
  });

  it('drops unknown parameters and empty values', () => {
    expect(selectionFromParams({ q: 'ingress', domain: '', nope: 'x' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run packages/query/src/filters.test.ts
```

Expected: FAIL — `Failed to resolve import "./filters"`.

- [ ] **Step 3: Write the implementation**

Create `packages/query/src/filters.ts`:

```ts
import { TAXONOMY, facetableFamilies, family, isValue } from '@keco/core';
// One definition of the attribute mapping, in the package that owns the index settings.
import { familyAttribute } from '@keco/search';

/**
 * Pure Meilisearch filter and facet construction (AGENTS.md §5). No client, no I/O — which
 * is what makes it testable, and what keeps `searchTools` down to one readable call.
 *
 * Everything here loops over the taxonomy rather than naming families, so adding a family
 * is a YAML edit plus a rebuild and nothing in this package changes.
 */

/** family id → selected value ids. */
export type FacetSelection = Record<string, string[]>;

export type FilterParams = {
  filters?: FacetSelection;
  /** Repository facts, not taxonomy families — open vocabularies that cannot be declared. */
  language?: string[];
  license?: string[];
  includeArchived?: boolean;
  /** Courses, blogs and dotfiles are demoted at projection; filtered out here (§14). */
  minRelevance?: number;
};

const inClause = (attribute: string, values: string[]) =>
  `${attribute} IN [${values.map((value) => `"${value}"`).join(', ')}]`;

export function buildFilters(params: FilterParams): string[] {
  const filters: string[] = [];

  for (const taxonomyFamily of TAXONOMY) {
    const selected = params.filters?.[taxonomyFamily.id];
    if (selected?.length) filters.push(inClause(familyAttribute(taxonomyFamily.id), selected));
  }

  if (params.language?.length) filters.push(inClause('language', params.language));
  if (params.license?.length) filters.push(inClause('license', params.license));

  if (!params.includeArchived) filters.push('archived = false');
  filters.push(`k8s_relevance >= ${params.minRelevance ?? 0.4}`);

  return filters;
}

/** Every facet distribution the home page and the search sidebar need, in one query. */
export const defaultFacets = (): string[] => facetableFamilies().map(familyAttribute);

type RawParams = Record<string, string | string[] | undefined>;

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : value.split(',');

/**
 * Reads a URL query object into a selection, using each family's declared `param` and
 * dropping anything not in the vocabulary — a hand-edited URL must not reach Meilisearch
 * as a filter on a value that cannot exist.
 */
export function selectionFromParams(params: RawParams): FacetSelection {
  const selection: FacetSelection = {};
  for (const taxonomyFamily of TAXONOMY) {
    const values = asList(params[taxonomyFamily.param])
      .map((value) => value.trim())
      .filter((value) => value !== '' && isValue(taxonomyFamily.id, value));
    if (values.length) selection[taxonomyFamily.id] = values;
  }
  return selection;
}

/** The URL parameter a family is selected by — for building links. */
export const paramForFamily = (familyId: string): string => family(familyId).param;

// Re-exported so the portal has one import for everything facet-shaped.
export { familyAttribute };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run packages/query/src/filters.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Rewire searchTools**

In `packages/query/src/index.ts`, replace the import block at the top:

```ts
import { fromDocumentId, toDocumentId, type ToolDocument } from '@keco/core';
import { TOOLS_ALIAS } from '@keco/search';
import { Meilisearch } from 'meilisearch';
import { buildFilters, defaultFacets, type FacetSelection } from './filters';
```

Replace the `SearchParams` type (lines 32-46) with:

```ts
export type SearchParams = {
  q?: string;
  /**
   * Taxonomy selections, keyed by family id. Nothing in this package knows the family
   * names — they come from taxonomy.yaml (§6).
   */
  filters?: FacetSelection;
  language?: string[];
  license?: string[];
  includeArchived?: boolean;
  /** Courses, blogs and dotfiles are demoted at projection; filtered out here (§14). */
  minRelevance?: number;
  sort?: 'relevance' | 'stars' | 'score' | 'momentum' | 'recent';
  page?: number;
  hitsPerPage?: number;
  /** Attributes to compute a facet distribution for. Defaults to every facetable family. */
  facets?: string[];
};
```

Replace the body of `searchTools` (lines 65-96) with:

```ts
export async function searchTools(client: QueryClient, params: SearchParams = {}): Promise<SearchResult> {
  const response = await index(client).search(params.q ?? '', {
    filter: buildFilters(params),
    sort: SORTS[params.sort ?? 'relevance'],
    page: params.page ?? 1,
    hitsPerPage: params.hitsPerPage ?? 20,
    // Facet distribution is the only aggregation this system has (§5).
    facets: params.facets ?? defaultFacets(),
  });

  return {
    hits: response.hits,
    total: response.totalHits ?? response.hits.length,
    page: response.page ?? 1,
    hitsPerPage: response.hitsPerPage ?? 20,
    facets: response.facetDistribution ?? {},
    processingTimeMs: response.processingTimeMs,
  };
}
```

Update `findAlternatives` (line 124) to use the new shape:

```ts
  const result = await searchTools(client, {
    filters: { kind: [tool.kind], domains: tool.domains },
    sort: 'score',
    hitsPerPage: limit + 10,
  });
```

Update `whatsHot` (line 144):

```ts
  const result = await searchTools(client, {
    filters: options.domain ? { domains: [options.domain] } : undefined,
    sort: 'momentum',
    hitsPerPage: options.limit ?? 10,
  });
```

And change `whatsHot`'s signature (line 142), since `Domain` is now `string`:

```ts
export async function whatsHot(
  client: QueryClient,
  options: { domain?: string; limit?: number } = {},
): Promise<ToolDocument[]> {
```

Finally, re-export the filter helpers from the package at the bottom of the file, replacing the existing export line:

```ts
export { fromDocumentId, toDocumentId };
export { buildFilters, defaultFacets, familyAttribute, paramForFamily, selectionFromParams } from './filters';
export type { FacetSelection } from './filters';
export type { ToolDocument };
```

- [ ] **Step 6: Typecheck**

```bash
pnpm -r --parallel check
```

Expected: FAIL in `@keco/web` — `apps/web/src/app/(portal)/search/page.tsx` still passes `kind`, `domains` and `install`. Task 11 fixes it. Do not fix it here.

- [ ] **Step 7: Commit**

```bash
git add packages/query/src
git commit -m "feat(query): build filters and facets generically from the taxonomy"
```

---

## Task 11: The portal

**Files:**
- Create: `apps/web/src/lib/topics.ts`
- Test: `apps/web/src/lib/topics.test.ts`
- Create: `apps/web/src/app/(portal)/topic-chips.tsx`
- Modify: `apps/web/src/app/(portal)/page.tsx`
- Modify: `apps/web/src/app/(portal)/search/page.tsx`
- Modify: `apps/web/next.config.ts`

The chip logic lives in a plain `.ts` module because vitest collects `apps/*/src/**/*.test.ts` only, with a `node` environment and no DOM. The `.tsx` file maps rows to JSX and holds no logic.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/topics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chipRows } from './topics';

const distribution = {
  kind: { cli: 412, operator: 288, controller: 190 },
  domains: { security: 340, observability: 297 },
  openness: { 'fully-open': 900, unknown: 4000 },
};

describe('chipRows', () => {
  it('builds one row per family that has counts', () => {
    const rows = chipRows(distribution);
    expect(rows.map((row) => row.familyId)).toEqual(['kind', 'domains', 'openness']);
  });

  it('labels rows and chips from the taxonomy', () => {
    const [kind] = chipRows(distribution);
    expect(kind!.label).toBe('Kind');
    expect(kind!.chips[0]!.label).toBe('CLI');
    expect(kind!.chips[0]!.description).toContain('command-line');
  });

  it('sorts chips by count, descending', () => {
    const [kind] = chipRows(distribution);
    expect(kind!.chips.map((chip) => chip.id)).toEqual(['cli', 'operator', 'controller']);
  });

  it('links each chip to search using the family parameter', () => {
    const [, domains] = chipRows(distribution);
    expect(domains!.chips[0]!.href).toBe('/search?domain=security');
  });

  it('never renders a hidden value', () => {
    const openness = chipRows(distribution).find((row) => row.familyId === 'openness');
    expect(openness!.chips.map((chip) => chip.id)).toEqual(['fully-open']);
  });

  it('omits a family with no counts rather than rendering an empty row', () => {
    expect(chipRows({ kind: {} }).length).toBe(0);
  });

  it('returns nothing for an empty index', () => {
    expect(chipRows({})).toEqual([]);
  });

  it('caps a row and offers a more link past the cap', () => {
    const rows = chipRows(distribution, 2);
    expect(rows[0]!.chips).toHaveLength(2);
    expect(rows[0]!.moreHref).toBe('/search');
  });

  it('offers no more link when everything fits', () => {
    expect(chipRows(distribution, 12)[0]!.moreHref).toBeNull();
  });

  it('reads the nested install method distribution', () => {
    const rows = chipRows({ 'install_methods.method': { krew: 180, helm: 300 } });
    expect(rows[0]!.familyId).toBe('install_methods');
    expect(rows[0]!.chips.map((chip) => chip.id)).toEqual(['helm', 'krew']);
    expect(rows[0]!.chips[0]!.href).toBe('/search?install=helm');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run apps/web/src/lib/topics.test.ts
```

Expected: FAIL — `Failed to resolve import "./topics"`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/topics.ts`:

```ts
import { facetableFamilies, family, values } from '@keco/core';
import { familyAttribute, paramForFamily } from '@keco/query';

/**
 * Turns a Meilisearch facet distribution into the chip rows the home page renders (§9).
 * Pure, so it is unit-testable without a DOM — the .tsx component below holds no logic.
 *
 * A value with no documents behind it does not render. That keeps an empty index (which is
 * the state until the first crawl) showing nothing rather than a wall of dead links, and it
 * means a taxonomy value nobody matched is silently absent instead of a zero-count chip.
 */
export type Chip = {
  id: string;
  label: string;
  description: string;
  count: number;
  href: string;
};

export type ChipRow = {
  familyId: string;
  label: string;
  description: string;
  chips: Chip[];
  /** Set when the row was capped, so the UI can offer the full list. */
  moreHref: string | null;
};

export const DEFAULT_CHIP_LIMIT = 12;

export function chipRows(
  distribution: Record<string, Record<string, number>>,
  limit = DEFAULT_CHIP_LIMIT,
): ChipRow[] {
  const rows: ChipRow[] = [];

  for (const familyId of facetableFamilies()) {
    const counts = distribution[familyAttribute(familyId)] ?? {};
    const param = paramForFamily(familyId);

    const chips = values(familyId)
      .map((value) => ({
        id: value.id,
        label: value.label,
        description: value.description,
        count: counts[value.id] ?? 0,
        href: `/search?${param}=${encodeURIComponent(value.id)}`,
      }))
      .filter((chip) => chip.count > 0)
      .sort((a, b) => b.count - a.count);

    if (chips.length === 0) continue;

    const definition = family(familyId);
    rows.push({
      familyId,
      label: definition.label,
      description: definition.description,
      chips: chips.slice(0, limit),
      moreHref: chips.length > limit ? '/search' : null,
    });
  }

  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run apps/web/src/lib/topics.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Write the chip component**

Create `apps/web/src/app/(portal)/topic-chips.tsx`:

```tsx
import Link from 'next/link';
import type { ChipRow } from '@/lib/topics';

/**
 * Browse-by-topic rows (§9). Plain links, so the page works with JavaScript disabled —
 * §15.5 requires it and it is also what makes the rows crawlable.
 */
export function TopicChips({ rows }: { rows: ChipRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="browse">
      <h2 id="browse">Browse</h2>
      {rows.map((row) => (
        <nav key={row.familyId} aria-label={row.label}>
          <h3>{row.label}</h3>
          <ul>
            {row.chips.map((chip) => (
              <li key={chip.id}>
                <Link href={chip.href} title={chip.description}>
                  {chip.label} <span aria-label={`${chip.count} tools`}>{chip.count}</span>
                </Link>
              </li>
            ))}
            {row.moreHref && (
              <li>
                <Link href={row.moreHref}>more →</Link>
              </li>
            )}
          </ul>
        </nav>
      ))}
    </section>
  );
}
```

- [ ] **Step 6: Wire the home page**

Replace `apps/web/src/app/(portal)/page.tsx` with:

```tsx
import Link from 'next/link';
import { searchTools, whatsHot } from '@keco/query';
import { query } from '@/lib/query';
import { chipRows } from '@/lib/topics';
import { TopicChips } from './topic-chips';

/**
 * Home — RSC (§9). Keep request-scoped APIs (cookies(), headers()) out of portal routes:
 * touching one silently turns the route dynamic and `revalidate` stops meaning anything.
 */
export const revalidate = 900;

export default async function HomePage() {
  // hitsPerPage: 0 buys the facet distribution for every family without paying for hits.
  const [hot, browse] = await Promise.all([
    whatsHot(query, { limit: 12 }),
    searchTools(query, { hitsPerPage: 0 }),
  ]);

  return (
    <main>
      <h1>Keco</h1>
      <p>Find the right Kubernetes tool in 10 seconds, not 10 browser tabs.</p>

      <form action="/search">
        <label htmlFor="q">Search the Kubernetes ecosystem</label>
        {/* Works with JS disabled — the search page reads the same URL state (§15.5). */}
        <input id="q" name="q" type="search" placeholder="ingress controller, cost, backup…" />
        <button type="submit">Search</button>
      </form>

      {/* Renders nothing until the first crawl has filled the index. */}
      <TopicChips rows={chipRows(browse.facets)} />

      {/* "Momentum", never "trending this week": there is no history to measure (§4.3). */}
      <h2>Highest momentum</h2>
      <ul>
        {hot.map((tool) => (
          <li key={tool.id}>
            <Link href={`/tools/${tool.full_name}`}>{tool.full_name}</Link> — {tool.summary}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 7: Wire the search page**

In `apps/web/src/app/(portal)/search/page.tsx`, replace the imports and the `searchTools` call. The whole `list` helper goes away — `selectionFromParams` does that job now, and it also drops values that are not in the vocabulary.

```tsx
import Link from 'next/link';
import { searchTools, selectionFromParams } from '@keco/query';
import { query } from '@/lib/query';

/**
 * Search (§9). State lives in the URL (`?q=&kind=&domain=&install=&sort=&view=`) so
 * results are shareable and back/forward work. This server rendering is the no-JS
 * baseline; the interactive client component layers on top of the same URL state.
 *
 * Every taxonomy family is readable from the URL by its declared `param`, so a new family
 * needs no change here.
 */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : '';

  const results = await searchTools(query, {
    q,
    filters: selectionFromParams(params),
    sort: (params.sort as 'relevance' | 'stars' | 'score' | 'momentum' | 'recent') ?? 'relevance',
    page: Number(params.page ?? 1),
  });
```

Leave the rest of the file (the JSX from `return (` onwards) untouched.

- [ ] **Step 8: Make sure the YAML survives a production build**

In `apps/web/next.config.ts`, add the tracing include:

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources; there is no build step between them.
  transpilePackages: ['@keco/core', '@keco/query', '@keco/cache'],
  // @keco/core reads taxonomy.yaml from disk at module load. It is not an import, so the
  // bundler cannot see it — trace it explicitly or a standalone build throws on boot.
  outputFileTracingIncludes: {
    '/**': ['../../packages/core/taxonomy.yaml'],
  },
  // README images are rewritten against the repo's image_base_url and come from GitHub (§9).
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'github.com' },
      { protocol: 'https', hostname: 'img.shields.io' },
    ],
  },
};

export default nextConfig;
```

- [ ] **Step 9: Typecheck and build**

```bash
pnpm -r --parallel check && pnpm -F @keco/web build
```

Expected: both PASS. The build renders the home page against whatever Meilisearch holds; with an empty or unreachable index `whatsHot` and `searchTools` return empty results and `TopicChips` renders nothing.

**This step is the one that proves the taxonomy loader survives a bundler.** `@keco/core` reads
`taxonomy.yaml` from disk using a path derived from `import.meta.url`; if Next rewrites that
during bundling, the build fails at module init with `taxonomy: taxonomy.yaml not found at
<path>`. That error is the signal, and it is deliberately the only place this is verified — the
plan carries no speculative fallback for it. If it fires, fix it with the evidence in hand: the
reported path tells you what the bundler produced. Do not add a resolution fallback before
seeing it fail.

Then confirm the page actually renders rather than merely compiling:

```bash
mise run infra:up && mise run search:settings
pnpm -F @keco/web build && pnpm -F @keco/web start &
sleep 5 && curl -sS localhost:3000 | head -40
```

Expected: HTML containing the `<h1>Keco</h1>` and the search form. With an empty index there are
no chips — that is correct, not a failure. Kill the server afterwards.

If the build fails because Meilisearch is not running, start it first:

```bash
mise run infra:up && mise run search:settings
```

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "feat(web): browse-by-topic chips on the home page, generic facets on search"
```

---

## Task 12: The standalone validator and the mise task

**Files:**
- Create: `packages/core/src/bin/check-taxonomy.ts`
- Modify: `packages/core/package.json`
- Modify: `mise.toml`

- [ ] **Step 1: Write the validator**

Create `packages/core/src/bin/check-taxonomy.ts`:

```ts
import { TAXONOMY } from '../taxonomy';

/**
 * `mise run taxonomy:check`. Importing the loader is the check: a malformed file throws at
 * module load with a message naming the problem. This binary exists so a broken taxonomy
 * fails the CI gate on its own line rather than inside an unrelated test's stack trace.
 */
let values = 0;
for (const family of TAXONOMY) {
  values += family.values.length;
  const hidden = family.values.filter((value) => value.hidden).length;
  const aliases = family.values.reduce((total, value) => total + value.aliases.length, 0);
  console.log(
    `${family.id.padEnd(16)} ${family.cardinality.padEnd(5)} ${family.source.padEnd(9)} ` +
      `${String(family.values.length).padStart(3)} values (${hidden} hidden, ${aliases} aliases)`,
  );
}
console.log(`\ntaxonomy ok — ${TAXONOMY.length} families, ${values} values`);
```

- [ ] **Step 2: Add the package script**

In `packages/core/package.json`, add to `scripts` and add `tsx` to `devDependencies` (mirroring `@keco/search`):

```json
  "scripts": {
    "check": "tsc --noEmit",
    "taxonomy:check": "tsx src/bin/check-taxonomy.ts"
  },
  "dependencies": {
    "yaml": "^2.8.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "tsx": "^4.23.1",
    "typescript": "5.9.3"
  }
```

Then:

```bash
pnpm install
```

- [ ] **Step 3: Add the mise task and put it in the gate**

In `mise.toml`, add after the `[tasks.test]` block:

```toml
[tasks."taxonomy:check"]
description = "Validate packages/core/taxonomy.yaml (schema, duplicates, unknown defaults)"
run = "pnpm -F @keco/core taxonomy:check"
```

and extend the CI gate:

```toml
[tasks.ci]
description = "Everything that must be green before declaring work done"
depends = ["check", "lint", "test", "taxonomy:check"]
```

- [ ] **Step 4: Run it**

```bash
mise run taxonomy:check
```

Expected output ends with:

```
taxonomy ok — 8 families, 83 values
```

- [ ] **Step 5: Verify it catches a broken file**

```bash
cp packages/core/taxonomy.yaml /tmp/taxonomy.bak
sed -i '' 's/      - id: operator$/      - id: cli/' packages/core/taxonomy.yaml
mise run taxonomy:check; echo "exit=$?"
cp /tmp/taxonomy.bak packages/core/taxonomy.yaml
```

Expected: non-zero exit with `taxonomy: duplicate value id: kind/cli`. Confirm `git diff --stat packages/core/taxonomy.yaml` is empty afterwards.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/bin/check-taxonomy.ts packages/core/package.json mise.toml pnpm-lock.yaml
git commit -m "feat(core): taxonomy:check task, wired into the CI gate"
```

---

## Task 13: Documentation and the worker TODOs

**Files:**
- Modify: `docs/taxonomy.md`
- Modify: `CLAUDE.md`
- Modify: `apps/workers/src/analyzer/index.ts`, `apps/workers/src/projector/index.ts`

§15.7 requires updating `CLAUDE.md` when a contract changes, and `docs/` when the taxonomy changes. Both changed.

- [ ] **Step 1: Rewrite docs/taxonomy.md**

Replace the whole file with:

```markdown
# Taxonomy rationale

The vocabulary lives in [`packages/core/taxonomy.yaml`](../packages/core/taxonomy.yaml) and is
**closed**. Adding a value is a deliberate PR that adds its rationale here — not an ad-hoc string
at a call site, and not a value with no rule behind it.

## The eight families

| Family | Cardinality | Assigned by |
|---|---|---|
| `kind` | exactly one | analyzer rules, LLM fallback |
| `domains` | one to three | analyzer rules, LLM fallback |
| `runtime` | exactly one | analyzer rules |
| `install_methods` | any number | registry proof only |
| `license_class` | exactly one | derived from the SPDX id |
| `openness` | exactly one | derived from licence and repository markers |
| `maturity` | exactly one | derived from the CNCF landscape, age and activity |
| `governance` | exactly one | derived from the CNCF landscape and the account type |

## Why more than one axis

`kind` is what the artifact *is*; `domains` is what problem it solves; `runtime` is where it
executes. cert-manager is a `controller`, solving `security`, running `in-cluster`; k9s is a
`cli`, solving `troubleshooting`, running on your `workstation`. A flat category list cannot
express that without either duplicating entries or losing information. Every consumer — search
facets, related tools, alternatives — depends on the axes being separable.

`runtime` deliberately does not overlap `install_methods`. "How do I get it" is a proven registry
fact with a command and a URL behind it; "where does it run" is a classification. No value
appears in both.

## Unknown is a real answer

Every family whose classification can fail declares `unknown`, and `unknown` is the default.
A missing licence does not make a project closed; a repository absent from the CNCF landscape is
not therefore vendor-owned. This is the same rule §4.2 applies to a missing Scorecard: absence
renormalises, it never scores as zero. `unknown` values are `hidden: true` and never render.

`openness` is the family most likely to make a wrong public claim about someone's project. It is
promoted to `fully-open` only on positive evidence — an OSI licence *and* no enterprise markers.
If it proves noisy against real data, tighten the rule. Do not backfill guesses.

## Health of the vocabulary

A category holding 3 tools, or 4000, is a taxonomy bug, not a fact about the ecosystem. The
backoffice taxonomy screen shows corpus facet counts precisely so this stays visible.

## Adding a value

1. Show the repos that do not fit any existing value — at least ten.
2. Say which existing value they are currently mis-assigned to, and why that hurts a real query.
3. Add the value to `taxonomy.yaml` with a label and a description that says what it means, not
   what it is called.
4. Add the rule that detects it, and a fixture in `packages/analyze/fixtures` proving the rule.
5. Run `mise run ci`. The pinning test in `packages/analyze/src/rules/pinning.test.ts` fails if a
   rule emits a value the file does not declare, and — for the derived families — if the file
   declares a value no rule can produce.
6. Re-analyze from cache and diff the classification output.

## Adding a family

A new family also needs a new `filterableAttribute`, which is a settings change, which means a
rebuild and an alias swap — never a mutation of the live index (§5). Everything else is derived:
`packages/search`, `packages/query` and the home page all loop over the file.

## Install methods

`install_methods` is not a taxonomy of package managers in the abstract: each entry must carry a
verified command and a `source_url` proving the entry exists in that registry. If it cannot be
proven, it is not listed. Rendering a `brew install` line for a formula that does not exist is the
single worst bug this project can ship.
```

- [ ] **Step 2: Update CLAUDE.md §6**

Replace the whole of section 6 (from `## 6. Taxonomy — two axes, never one` up to but not including `## 7. Repository layout`) with:

```markdown
## 6. Taxonomy — declared in YAML, never in code

`packages/core/taxonomy.yaml`. Closed vocabulary; adding a value is a deliberate PR with
rationale in `docs/taxonomy.md`, a rule that detects it and a fixture proving the rule — not an
ad-hoc string. The file is loaded and fully validated at module init; a malformed taxonomy takes
every worker and the web app down immediately rather than letting them classify into a vocabulary
that does not exist.

Eight families, each declaring `id`, `label`, `param` (its URL query parameter), `cardinality`,
`source` and its values. Each value declares `label`, `description`, optional `aliases` (GitHub
topics for `domains`, SPDX ids for `license_class`) and optional `hidden`.

**Assigned by the analyzer:**
- **`kind`** — what the artifact *is* (exactly one): `cli` · `kubectl-plugin` · `operator` ·
  `controller` · `helm-chart` · `crd-library` · `admission-webhook` · `distribution` ·
  `dashboard-ui` · `library-sdk` · `terraform-provider` · `ide-extension` · `service` ·
  `learning-resource`
- **`domains`** — what problem it solves (1–3): `networking` · `security` · `policy` · `storage` ·
  `database` · `observability` · `ci-cd` · `gitops` · `packaging` · `autoscaling` · `scheduling` ·
  `cost` · `multi-cluster` · `backup-dr` · `service-mesh` · `secrets` · `serverless` ·
  `dev-experience` · `testing` · `ai-ml` · `edge` · `troubleshooting`
- **`runtime`** — where it executes (exactly one): `in-cluster` · `workstation` · `ci-pipeline` ·
  `in-your-code` · `cluster-itself` · `hosted-service` · `unknown`

**Proven against a registry:**
- **`install_methods`** — detected, never guessed: `brew` · `mise` · `asdf` · `krew` · `helm` ·
  `kubectl-apply` · `go-install` · `cargo` · `npm` · `pip` · `nix` · `arkade` · `apt` ·
  `container-image` · `curl-script` · `github-release` · `operator-hub`

  Each carries a **verified command** (`brew install k9s`) and a `source_url` proving the entry
  exists in that registry. Unprovable ⇒ not listed. Rendering a `brew install` line for a formula
  that doesn't exist is the single worst bug this project can ship — people paste these into a
  terminal.

**Derived from cached metadata:**
- **`license_class`** — `permissive` · `weak-copyleft` · `copyleft` · `source-available` ·
  `public-domain` · `unknown`
- **`openness`** — `fully-open` · `open-core` · `source-available` · `unknown`
- **`maturity`** — `cncf-graduated` · `cncf-incubating` · `cncf-sandbox` · `established` ·
  `young` · `dormant` · `archived` · `unknown`
- **`governance`** — `foundation` · `vendor-backed` · `community` · `individual` · `unknown`

**Unknown is a real answer.** Every family whose classification can fail declares `unknown` and
defaults to it. Absence of evidence never becomes a positive claim — the same rule §4.2 applies to
a missing Scorecard. `unknown` values are hidden from the UI.

**The vocabulary is data, so the types are `string`.** `Kind` and `Domain` are no longer literal
unions; validation is a zod refinement against the loaded file. The compile-time check is replaced
by `packages/analyze/src/rules/pinning.test.ts`, which asserts every value a rule can emit exists
in the file. If you add a rule, that test is how a typo gets caught.

**Adding a family** means a new `filterableAttribute`, which is a settings change, which means a
rebuild and an alias swap (§5). Everything else — `packages/search`, `packages/query`, the home
page chip rows — loops over the file and needs no edit.
```

- [ ] **Step 2b: Update CLAUDE.md §5 as well**

§5's `tools` settings section lists `filterableAttributes` and the document shape, both of which
changed in Tasks 4 and 9. In the `filterableAttributes` bullet, add the five new families:

```markdown
- `filterableAttributes`: `kind`, `domains`, `runtime`, `install_methods`, `language`, `license`,
  `license_class`, `openness`, `maturity`, `governance`, `archived`, `stars`, `has_release`,
  `k8s_relevance`, `has_scorecard`.
```

In the same section's `searchableAttributes` bullet, rename `topics` to `github_topics`. In the
**Document shape** code block, rename the `topics[]` field to `github_topics[]` and add the five
new fields next to `kind` and `domains`. A `facet: true` family with no filterable attribute
behind it is a chip that 500s when clicked, so these two lists must not drift.

- [ ] **Step 3: Update the two worker TODOs**

In `apps/workers/src/analyzer/index.ts`, extend the pass-1 line of the TODO block so whoever implements it knows the new classifiers exist:

```ts
    // TODO(analyzer): implement the three passes (§4.2):
    //   pass 1 — classifyKind / classifyDomains / k8sRelevance / classifyRuntime /
    //            classifyDerived over the cached payloads. classifyDerived takes the
    //            repo.json licence, timestamps and owner type, plus the CNCF landscape
    //            lookup — pass `landscape: null` until the crawler caches that seed, which
    //            degrades maturity and governance to `unknown` rather than guessing.
    //   NOTE: AnalysisSchema defaults the five taxonomy fields to `unknown`, so an
    //   analysis written before those families existed stays parseable on replay — but it
    //   also stays `unknown` forever, because an unchanged content_hash never re-triggers
    //   analysis. Re-classification is not driven by content_hash alone (§14). When these
    //   passes land, force one full-corpus pass-1 re-run for the new fields rather than
    //   waiting for organic change: it is free, being rules over data already in cache.
```

In `apps/workers/src/projector/index.ts`, extend the document-building TODO:

```ts
    // TODO(projector): read repos/{repo}/repo.json + analysis/{repo}.json, compute the
    // four score axes plus momentum (z-scored across the corpus), build the ToolDocument,
    // and buffer it. Copy kind, domains, runtime, license_class, openness, maturity and
    // governance straight from the analysis — the projector classifies nothing, it only
    // scores. Send complete sub-objects: updateDocuments merges only at the top level, so
    // a partial `score` wipes the rest of it (§5, §14).
```

- [ ] **Step 4: Run the full gate**

```bash
mise run ci
```

Expected: `check`, `lint`, `test` and `taxonomy:check` all green.

- [ ] **Step 5: Commit**

```bash
git add docs/taxonomy.md CLAUDE.md apps/workers/src
git commit -m "docs(taxonomy): document the eight families and the YAML workflow"
```

---

## Definition of done

Run through §15 of `CLAUDE.md` before calling this finished:

- [ ] `mise run ci` green — `check`, `lint`, `test`, `taxonomy:check`.
- [ ] `mise run taxonomy:check` prints `8 families, 83 values`.
- [ ] `pnpm -F @keco/web build` succeeds.
- [ ] The four original fixtures still classify to the same `kind`, `rule` and `domains` as before this change. Nothing about the existing corpus behaviour moved.
- [ ] Deleting a value from `taxonomy.yaml` that a rule emits fails `mise run test` (spot-check one: remove `- id: operator` and confirm the pinning test fails, then restore it).
- [ ] Nothing on the read side writes; nothing on the write side reads a read model. `apps/web` imports `@keco/core` and `@keco/query` only.
- [ ] No `mise run rebuild` is needed yet — the index is empty until the first crawl. The settings change in Task 9 takes effect via `mise run search:settings` on a fresh index, never on a populated live alias.
