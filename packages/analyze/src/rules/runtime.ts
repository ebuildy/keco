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

// Deliberately duplicated from kind.ts rather than shared: the two rule sets are meant to
// evolve independently, and a shared helper would couple them (see task notes).
const isChartYaml = (path: string) =>
  path === 'Chart.yaml' || /(^|\/)charts\/[^/]+\/Chart\.yaml$/.test(path);

/** A root `action.yml` is a GitHub Action. A file under .github/workflows is not — that is CI *for* the repo. */
const isActionManifest = (path: string) => path === 'action.yml' || path === 'action.yaml';

const LIBRARY_MANIFEST = [
  { file: 'go.mod', pattern: /k8s\.io\/client-go|sigs\.k8s\.io\/controller-runtime/ },
  { file: 'package.json', pattern: /@kubernetes\/client-node/ },
  { file: 'Cargo.toml', pattern: /^kube\s*=/m },
];

const WORKSTATION_KINDS = new Set(['cli', 'kubectl-plugin', 'ide-extension']);
const IN_CLUSTER_KINDS = new Set([
  'operator',
  'controller',
  'admission-webhook',
  'helm-chart',
  'service',
  'dashboard-ui',
]);

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
    return { runtime: 'workstation', confidence: 0.8, rule: `kind:${kind}` };
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
