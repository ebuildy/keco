import { facetableFamilies, values } from '@keco/core';

/**
 * "Did you mean?" candidates for a query that returned nothing.
 *
 * **This module only proposes; it never asserts.** Every candidate it returns is verified
 * against the index before a reader sees it (`verifySuggestions` in `search.ts`), and only
 * those with real hits are rendered. Sending someone from one dead end to another would be a
 * worse experience than showing nothing, and §6's "unprovable ⇒ not listed" is the same
 * principle applied to install commands — a suggestion is a claim, and claims here are proven.
 *
 * Two sources, both offline and free:
 *
 * 1. **Spelling, against the bundled taxonomy vocabulary.** Meilisearch already tolerates one
 *    typo at five characters and two at nine, so a query that reached zero results has failed
 *    *past* that. What remains worth catching is a badly mangled category word —
 *    `observabilty`, `netwoking` — because the vocabulary is in the bundle already and costs
 *    nothing to match against.
 * 2. **Dropping a term.** A two-word query where one word is junk is the other common way to
 *    reach zero, and no amount of spelling correction fixes it. `ingress controler` still has
 *    `ingress` in it.
 *
 * There is deliberately no correction of tool *names*: the corpus vocabulary is not in the
 * browser, and guessing at 30k strangers' repository names from a bundled list would be the
 * fabrication this project's constitution keeps warning about.
 */

/**
 * Levenshtein distance, abandoned once it provably exceeds `max`.
 *
 * The bound is what makes this cheap enough to run against the whole taxonomy vocabulary on
 * every empty search: most pairs are rejected after a row or two rather than filling an
 * entire matrix.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const best = Math.min(substitution, deletion, insertion);
      current[j] = best;
      if (best < rowBest) rowBest = best;
    }

    // Every remaining row can only increase the running minimum, so once an entire row is
    // past the bound the final distance is too.
    if (rowBest > max) return max + 1;
    previous = current;
  }

  return previous[b.length] ?? max + 1;
}

/**
 * Every word the taxonomy declares, from value ids and labels alike — `helm-chart` yields
 * `helm` and `chart`, and so does "Helm chart".
 *
 * Built once. The taxonomy is frozen at module load and cannot change during the page's life,
 * and rebuilding this on every keystroke of a failing search would be waste for no benefit.
 */
let vocabularyCache: string[] | null = null;

export function vocabulary(): string[] {
  if (vocabularyCache) return vocabularyCache;

  const words = new Set<string>();
  for (const familyId of facetableFamilies()) {
    // `values()` skips hidden entries, so `unknown` never becomes a suggestion (§6).
    for (const value of values(familyId)) {
      for (const word of `${value.id} ${value.label}`.toLowerCase().split(/[\s\-_/]+/)) {
        // Short words are noise: at three characters almost everything is within two edits of
        // everything else, which produces confident nonsense.
        if (word.length >= 4) words.add(word);
      }
    }
  }

  vocabularyCache = [...words];
  return vocabularyCache;
}

/** Tighter tolerance for shorter words, where two edits is most of the word. */
const toleranceFor = (word: string): number => (word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0);

const terms = (query: string): string[] => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Candidate queries, best first, never including the original.
 *
 * Returns strings rather than rendered suggestions because none of them are trustworthy yet —
 * the caller has to prove each one returns hits.
 */
export function suggestQueries(query: string, limit = 4): string[] {
  const words = terms(query);
  if (words.length === 0) return [];

  const candidates: string[] = [];
  const seen = new Set([words.join(' ')]);

  const add = (candidate: string) => {
    if (candidate === '' || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  // 1. Spelling: replace one mangled word at a time with its nearest taxonomy term.
  const vocab = vocabulary();
  for (const [index, word] of words.entries()) {
    const tolerance = toleranceFor(word);
    if (tolerance === 0) continue;

    let best: { word: string; distance: number } | null = null;
    for (const candidate of vocab) {
      // A word already in the vocabulary is spelled correctly; correcting it to a neighbour
      // would turn `policy` into `police` and call it a suggestion.
      if (candidate === word) {
        best = null;
        break;
      }
      const distance = editDistance(word, candidate, tolerance);
      if (distance <= tolerance && (best === null || distance < best.distance)) {
        best = { word: candidate, distance };
      }
    }

    if (best) add(words.map((entry, at) => (at === index ? best.word : entry)).join(' '));
  }

  // 2. Relaxation: keep one term and drop the rest. Only for multi-word queries, and only
  //    after spelling, because a correction preserves more of what the reader asked for.
  if (words.length > 1) for (const word of words) add(word);

  return candidates.slice(0, limit);
}
