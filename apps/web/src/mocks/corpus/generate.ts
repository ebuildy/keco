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
