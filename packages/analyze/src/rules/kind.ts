import { aliasesFor, family, type Domain, type Kind } from '@keco/core';

/**
 * Pass 1 — local rules (AGENTS.md §4.2). Cache only, free, deterministic, reproducible.
 * These settle most of the corpus; the LLM only sees what is left ambiguous.
 *
 * Every rule added here requires a fixture in packages/analyze/fixtures proving it (§13).
 */
export type RuleInput = {
  repo: string;
  name: string;
  description: string | null;
  topics: string[];
  /** File paths from `tree.json`, paths only. */
  tree: string[];
  /** Manifest contents keyed by filename: go.mod, Chart.yaml, package.json, Cargo.toml… */
  manifests: Record<string, string>;
  language: string | null;
};

export type RuleVerdict = {
  kind: Kind;
  confidence: number;
  /** Which rule fired, for the analysis document's rules trace. */
  rule: string;
};

const has = (tree: string[], predicate: (path: string) => boolean) => tree.some(predicate);

/** Root chart or a chart in a monorepo's `charts/` directory — both are Helm charts. */
const isChartYaml = (path: string) =>
  path === 'Chart.yaml' || /(^|\/)charts\/[^/]+\/Chart\.yaml$/.test(path);

/**
 * Ordered strongest-first: a repo with `.krew.yaml` is a kubectl plugin even if it also
 * ships a Chart.yaml for its own deployment.
 */
const KIND_RULES: Array<{ rule: string; kind: Kind; confidence: number; test: (input: RuleInput) => boolean }> = [
  {
    rule: 'tree:.krew.yaml',
    kind: 'kubectl-plugin',
    confidence: 0.95,
    test: (i) => has(i.tree, (p) => p === '.krew.yaml' || p.endsWith('/.krew.yaml')),
  },
  {
    rule: 'name:kubectl-*',
    kind: 'kubectl-plugin',
    confidence: 0.8,
    test: (i) => /^kubectl[-_]/.test(i.name) || i.topics.includes('kubectl-plugin'),
  },
  {
    rule: 'tree:config/crd+PROJECT (kubebuilder)',
    kind: 'operator',
    confidence: 0.95,
    test: (i) => has(i.tree, (p) => p.startsWith('config/crd/')) && has(i.tree, (p) => p === 'PROJECT'),
  },
  {
    rule: 'topic:kubernetes-operator',
    kind: 'operator',
    confidence: 0.85,
    test: (i) => i.topics.includes('kubernetes-operator') || i.topics.includes('operator'),
  },
  {
    rule: 'tree:Chart.yaml',
    kind: 'helm-chart',
    confidence: 0.9,
    test: (i) => has(i.tree, isChartYaml),
  },
  {
    rule: 'manifest:controller-runtime',
    kind: 'controller',
    confidence: 0.8,
    test: (i) => /sigs\.k8s\.io\/controller-runtime/.test(i.manifests['go.mod'] ?? ''),
  },
  {
    rule: 'name:*-controller',
    kind: 'controller',
    confidence: 0.7,
    test: (i) => /-controller$/.test(i.name),
  },
  {
    rule: 'name:*-operator',
    kind: 'operator',
    confidence: 0.7,
    test: (i) => /-operator$/.test(i.name),
  },
  {
    rule: 'tree:webhook manifests',
    kind: 'admission-webhook',
    confidence: 0.75,
    test: (i) =>
      i.topics.includes('admission-webhook') ||
      has(i.tree, (p) => /webhook.*\.yaml$/.test(p) && p.includes('admission')),
  },
  {
    rule: 'manifest:terraform-provider',
    kind: 'terraform-provider',
    confidence: 0.9,
    test: (i) => /^terraform-provider-/.test(i.name),
  },
  {
    rule: 'manifest:client-go without cmd',
    kind: 'library-sdk',
    confidence: 0.65,
    test: (i) =>
      /k8s\.io\/client-go/.test(i.manifests['go.mod'] ?? '') &&
      !has(i.tree, (p) => p.startsWith('cmd/')),
  },
  {
    rule: 'manifest:@kubernetes/client-node',
    kind: 'library-sdk',
    confidence: 0.7,
    test: (i) => /@kubernetes\/client-node/.test(i.manifests['package.json'] ?? ''),
  },
  {
    rule: 'manifest:kube (Cargo.toml)',
    kind: 'library-sdk',
    confidence: 0.65,
    test: (i) => /^kube\s*=/m.test(i.manifests['Cargo.toml'] ?? ''),
  },
  {
    rule: 'tree:cmd/ + cobra',
    kind: 'cli',
    confidence: 0.75,
    test: (i) =>
      has(i.tree, (p) => p.startsWith('cmd/')) && /spf13\/cobra/.test(i.manifests['go.mod'] ?? ''),
  },
  {
    rule: 'topic:learning',
    kind: 'learning-resource',
    confidence: 0.8,
    test: (i) =>
      ['awesome', 'tutorial', 'course', 'learning', 'roadmap', 'cheatsheet'].some((t) =>
        i.topics.includes(t),
      ) || /^awesome-/.test(i.name),
  },
];

/** Every kind a pass-1 rule can emit. Asserted against taxonomy.yaml by pinning.test.ts. */
export const DECLARED_KINDS: string[] = [...new Set(KIND_RULES.map((rule) => rule.kind))];

/** Returns every rule that fired, strongest first. Empty means pass 1 could not decide. */
export function classifyKind(input: RuleInput): RuleVerdict[] {
  return KIND_RULES.filter((rule) => rule.test(input)).map(({ rule, kind, confidence }) => ({
    rule,
    kind,
    confidence,
  }));
}

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

/**
 * Plenty of repos mention Kubernetes without being ecosystem tools — courses, blogs,
 * dotfiles (§14). They stay in the cache; `k8s_relevance` filters them out at projection.
 */
export function k8sRelevance(input: RuleInput): number {
  let score = 0;
  const k8sTopics = input.topics.filter((t) => /^(kubernetes|k8s|kubectl|helm|openshift)/.test(t));
  if (k8sTopics.length > 0) score += 0.4;
  if (/kube|k8s/i.test(input.name)) score += 0.2;
  if (/kubernetes|k8s/i.test(input.description ?? '')) score += 0.15;
  if (
    /k8s\.io\/|sigs\.k8s\.io\//.test(input.manifests['go.mod'] ?? '') ||
    has(input.tree, (p) => isChartYaml(p) || p.startsWith('config/crd/'))
  ) {
    // A Chart.yaml or a CRD directory is a structural fact about the artifact, not a
    // mention: it cannot be there by accident the way a topic or a keyword can.
    score += 0.35;
  }
  // A CI manifest is not an ecosystem link (§4.1) — it is explicitly not counted here.
  return Math.min(1, score);
}
