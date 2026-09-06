import { artifactHubSeed, operatorHubSeed } from './artifacthub';
import { awesomeSeed } from './awesome';
import { cncfSeed } from './cncf';
import { krewSeed } from './krew';
import type { SeedAdapter } from './types';

export type { SeedAdapter, SeedContext, SeedRef } from './types';

/**
 * The registry of seeds — the adapters that answer *which* repos to crawl (AGENTS.md §4.2).
 *
 * `seeds/github/` is the deliberate exception in this directory and is NOT registered here: it
 * answers *what is in one repo*, not which repos exist, so it has no `refs()` and nothing
 * selects it with `--seed`. The asymmetry is called out in the design spec §3.
 *
 * Order matters. `--seed` resolves in the order given, and the worklist crawls seeds before the
 * discovery corpus, so a `--limit` run spends its budget on the highest-signal sources first.
 */
export const SEEDS: Record<string, SeedAdapter> = {
  cncf: cncfSeed,
  krew: krewSeed,
  artifacthub: artifactHubSeed,
  operatorhub: operatorHubSeed,
  awesome: awesomeSeed,
};

/** Declaration order: cncf and krew first, which is also the CLI's default `--seed`. */
export const SEED_NAMES = Object.keys(SEEDS);

/**
 * Rejects an unknown name rather than silently crawling less than asked. A typo'd `--seed`
 * that quietly does nothing is how a scheduled crawl reports success on an empty corpus.
 */
export function resolveSeeds(names: readonly string[]): SeedAdapter[] {
  const resolved: SeedAdapter[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) continue;
    const adapter = SEEDS[name];
    if (adapter === undefined) {
      throw new Error(`unknown seed "${name}" — available: ${SEED_NAMES.join(', ')}`);
    }
    seen.add(name);
    resolved.push(adapter);
  }

  return resolved;
}
