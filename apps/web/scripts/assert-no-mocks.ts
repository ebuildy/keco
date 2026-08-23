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

/**
 * Returns one human-readable finding per (file, marker) hit. Empty means clean.
 *
 * Each marker is checked against both the file's relative path and its contents: the MSW
 * worker ships as a file literally named `mockServiceWorker.js`, which is itself proof of
 * shipping, whether or not the marker string recurs inside the file's own source.
 */
export function scanForMocks(root: string): string[] {
  const findings: string[] = [];

  for (const path of walk(root)) {
    if (!TEXT_FILE.test(path)) continue;
    const relativePath = relative(root, path);
    const contents = readFileSync(path, 'utf8');
    for (const marker of MOCK_MARKERS) {
      if (relativePath.includes(marker) || contents.includes(marker)) {
        findings.push(`${relativePath} contains "${marker}"`);
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
