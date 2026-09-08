/**
 * Which manifest files are worth fetching, decided from `tree.json` paths alone (AGENTS.md §3).
 * Pure, and deliberately small: these files are what the analyzer's pass 1 reads to detect a
 * dependency on `sigs.k8s.io/controller-runtime`, `k8s.io/client-go`, `kube` or
 * `@kubernetes/client-node` (§4.3).
 *
 * Tree-path-only signals — `.krew.yaml`, `PROJECT`, `config/crd/` — are NOT here. They are
 * already in `tree.json`, so fetching them would buy nothing.
 *
 * These are fetched from raw.githubusercontent.com, which costs no GitHub API quota. The bound
 * below is therefore about bytes and wall-clock, not points.
 */

/** Declared order. The result follows this, not tree order, so it is deterministic. */
export const MANIFEST_FILES = [
  'go.mod',
  'Chart.yaml',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
] as const;

export const MAX_MANIFESTS = 6;

/** A helm repo keeps its chart under `charts/{name}/`; without this the root scan misses it. */
const CHART_FILE = 'Chart.yaml';

export function selectManifests(treePaths: readonly string[]): string[] {
  const paths = new Set(treePaths);
  const selected: string[] = MANIFEST_FILES.filter((file) => paths.has(file));

  if (!paths.has(CHART_FILE)) {
    const nested = nestedChart(treePaths);
    if (nested !== null) selected.push(nested);
  }

  return selected.slice(0, MAX_MANIFESTS);
}

/**
 * Shallowest wins, alphabetical breaks the tie. A repo publishing twelve charts gets one — the
 * analyzer needs proof it is a chart, not an inventory — and which one it gets must not depend
 * on the order GitHub happened to serialise the tree in.
 */
function nestedChart(treePaths: readonly string[]): string | null {
  const candidates = treePaths
    .filter((path) => path.endsWith(`/${CHART_FILE}`))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  return candidates[0] ?? null;
}
