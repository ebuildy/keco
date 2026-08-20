import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createAdminClient, ensureSearchOnlyKey } from '../index';

/**
 * `mise run setup` (via `mise run search:key`): mints or fetches the browser's search-only
 * Meilisearch key and writes it into the workspace-root `.env`, so a fresh clone gets a
 * working portal without a manual "go copy a key out of Meilisearch" step.
 *
 * On `main` this needed no provisioning because the portal rendered server-side with the
 * master key. §9's browser-direct search means `VITE_MEILI_SEARCH_KEY` must be a real,
 * search-only, `tools`-scoped key before the first `vite dev` — §12 is explicit that the
 * browser must never fall back to the master key, so this mints the right thing instead of
 * papering over its absence.
 *
 * Never overwrites a value an operator already set — a different Meilisearch host, a key
 * rotated by hand, stays exactly as they left it.
 */
function findWorkspaceRoot(from = process.cwd()): string {
  for (let current = from; ; current = dirname(current)) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    if (dirname(current) === current) return from;
  }
}

const VAR = 'VITE_MEILI_SEARCH_KEY';
const ASSIGNMENT = new RegExp(`^${VAR}=.*$`, 'm');

const client = createAdminClient();
const key = await ensureSearchOnlyKey(client);

const envPath = join(findWorkspaceRoot(), '.env');

if (!existsSync(envPath)) {
  console.log(`search-only key ready: ${key}`);
  console.log(`No .env found at ${envPath} — set ${VAR} to the value above (or run \`mise run env:init\` first).`);
  process.exit(0);
}

const contents = await readFile(envPath, 'utf8');
const match = ASSIGNMENT.exec(contents);

if (!match) {
  const withNewline = contents.endsWith('\n') ? contents : `${contents}\n`;
  await writeFile(envPath, `${withNewline}${VAR}=${key}\n`, 'utf8');
  console.log(`search-only key ready — appended ${VAR} to .env`);
} else if (match[0] === `${VAR}=`) {
  await writeFile(envPath, contents.replace(ASSIGNMENT, `${VAR}=${key}`), 'utf8');
  console.log(`search-only key ready — wrote ${VAR} to .env`);
} else {
  console.log(`${VAR} is already set in .env — left it as is`);
}
