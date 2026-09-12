/**
 * Which published package this repo *is*, derived from a manifest already in the cache
 * (AGENTS.md §4.3 pass 2). OSV.dev needs an ecosystem and a name to query precisely — a bare
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
      // Not valid JSON — degrade, never fail (§4.3).
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
