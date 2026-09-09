# Analyzer (pass 1/2/3) — design

**Date:** 2026-09-08
**Status:** approved, not implemented
**Touches:** `packages/signals`, `packages/analyze`, `apps/workers/src/analyzer`, `ROADMAP.md`

The analyzer is the middle of the pipeline (AGENTS.md §4.3): it turns a crawled repo
(`repos/**`) into a classified one (`analysis/**`), in three passes, cheapest first. Pass 1
(local rules) is already written and fixture-tested. Nothing wires pass 2 (external signals) or
pass 3 (LLM fallback) together, and `apps/workers/src/analyzer/index.ts` is a stub that logs
what it would do. This spec is what closes that gap.

## 0. Context: what already exists

`packages/analyze/src/rules/{kind,runtime,derived}.ts` are complete and covered by
`packages/analyze/fixtures/*.json` + `pinning.test.ts`. They classify `kind`, `domains`,
`runtime`, `license_class`, `openness`, `maturity`, `governance` and `k8s_relevance` from cached
GitHub metadata alone — no network. Nothing in this spec touches them.

`packages/signals` has one working example (`scorecardProvider`) and four more adapters
(`depsDevProvider`, `osvProvider`, `brewProvider`, `artifactHubProvider`) built on the same
`Provider<T>` wrapper — cached, TTL'd, timed out, degrade-never-fail. Nothing calls any of them
yet.

`packages/analyze/src/llm.ts` declares the pass-3 shape (`LlmInput`, `CONFIDENCE_THRESHOLD`,
`README_BUDGET_BYTES`) but `classifyWithLlm` throws `not implemented`.

`apps/workers/src/analyzer/index.ts` reads the journal, finds `RepoFetched{changed:true}`
events, and stops — the whole body is a `TODO` comment. The CLI (`kecoctl repo analyze`) is
already fully wired with `--repo`, `--force-refresh` and `--min-confidence`; `runAnalyzer`
today ignores all three except for logging them.

## 1. Where each piece lives, and why

```
apps/workers/src/analyzer/index.ts   — I/O only: reads repos/** by key, calls analyzeRepo(),
                                        writes analysis/{repo}.json, appends RepoAnalyzed,
                                        advances the checkpoint. No classification decision
                                        lives here — same split as crawler/index.ts over
                                        sources/github/fetch.ts.
packages/analyze/src/analyze.ts      — analyzeRepo(): composes all three passes into one
                                        schema-validated Analysis document.
packages/analyze/src/signals.ts      — pass 2: gatherSignals(), the five providers + the two
                                        registries that can prove an install method.
packages/analyze/src/llm.ts          — pass 3: the real Anthropic tool-use call.
packages/analyze/src/rules/
  package-identity.ts                — pure: a manifest → {ecosystem, name} for OSV.
packages/signals/src/providers/
  index.ts                           — two small contract changes (§3), no new providers.
```

`packages/analyze` (not the app) owns pass 2 and pass 3 for the same reason it already owns
pass 1: it is a package with no cache-key knowledge, only cached *content* handed to it by the
caller, so its tests never touch the filesystem — only an in-memory `Storage` and, for pass 3, an
injected fake client. This mirrors how `sources/github/fetch.ts` is the one impure module for the
crawler, except here the impure module lives in the package rather than the app, matching
`packages/analyze`'s existing shape (it already depends on `@keco/cache` and `@keco/signals` in
its `package.json` — that dependency was scaffolded for exactly this).

## 2. Pass 2 — what gets proven, and what deliberately doesn't

### 2.1 Signals: Scorecard, deps.dev, OSV, unchanged in spirit

`scorecardProvider(cache).fetch(repo)` and `depsDevProvider(cache).fetch(repo)` are called as
written — no contract change. OSV is the one that needed one.

**OSV needs an ecosystem, not just a name.** The existing `osvProvider` sends
`{"package": {"name": key}}`; OSV's own docs and behavior say a bare name is ambiguous across
ecosystems (an npm package and a crate can share a name). Querying it wrong doesn't error — it
silently returns the wrong project's vulnerabilities, which is a false claim on this repo's
page, exactly the failure mode §14 exists to prevent. The fix: `encodeOsvKey(ecosystem, name)`
builds a composite key (`"Go::sigs.k8s.io/controller-runtime"`), and the provider's `request()`
splits it and sends both fields. `packages/analyze/src/rules/package-identity.ts` derives the
`{ecosystem, name}` pair from whichever manifest is present — `go.mod`'s `module` line,
`package.json`'s `name`, `Cargo.toml`'s `[package] name`, `pyproject.toml`'s `[project]`/
`[tool.poetry] name` — and returns `null` when none parses cleanly. **No manifest, no OSV
call** — this is a real, accepted gap (most `service`/`dashboard-ui`/`learning-resource` repos
carry no such manifest), not a bug to work around later.

### 2.2 Install-method proof: Homebrew + Artifact Hub only

§6 sets the bar: "Rendering a `brew install` line for a formula that doesn't exist is the
single worst bug this project can ship." Every install method in this pass must be backed by a
registry hit, not a guess.

**Homebrew.** `brewProvider(cache).fetch('all')` — one bulk file per TTL window for the whole
corpus (§4.2's "bulk over per-repo"). Match is exact, case-insensitive, on `formula.name` vs.
the repo's own `name`. §14 already documents the known gap this leaves (`ahmetb/kubectx` →
`kubectx`, not `ahmetb-kubectx` or similar) — accepted, because the alternative is a fuzzy match
that risks a false positive.

**Artifact Hub.** This is the one piece of this spec verified against a live response rather
than assumed from documentation, because getting the URL and command wrong is exactly the §6
failure mode. `GET /api/v1/packages/search?ts_query_web=<name>` was queried directly:

```
GET /api/v1/packages/search?ts_query_web=cert-manager
→ packages[0] = {
    name: "cert-manager", normalized_name: "cert-manager", official: true, stars: 990,
    repository: { name: "cert-manager", url: "https://charts.jetstack.io", kind: 0 }
  }

GET /api/v1/repositories/search?kind=5&name=krew
→ [{ name: "krew-index", kind: 5, url: "https://github.com/kubernetes-sigs/krew-index" }]

GET /api/v1/packages/krew/krew-index/ctx
→ { name: "ctx", normalized_name: "ctx", home_url: "https://github.com/ahmetb/kubectx", ... }
```

This confirms three things the old schema (`{name, repository: {name}}`, everything else
dropped) couldn't use:

- `repository.kind` is numeric and stable: `0` = Helm, `5` = krew. (Artifact Hub also indexes
  OLM operators, Falco rules, OPA policies and more under other codes — see §2.3.)
- The package's own page is `https://artifacthub.io/packages/{helm|krew}/{repository.name}/{normalized_name}`
  — a real URL a human can open to verify the claim, which is what `source_url` promises.
  a
- A correct, copy-pasteable command is constructable per kind: for Helm,
  `helm repo add {repository.name} {repository.url}` then `helm install {repo} {repository.name}/{normalized_name}`;
  for krew, `kubectl krew install {normalized_name}`.

Match is exact, case-insensitive, on `package.name` vs. the repo's own `name` — the same
conservative choice as Homebrew, and for the same reason: krew plugin names are frequently
abbreviated (`ctx`/`ns` for `kubectx`), so this under-detects krew plugins in exchange for never
producing a wrong one. Among multiple exact-name hits (the `cert-manager` query above returns
four, from four different, mostly-irrelevant Helm repositories), the `official` flag then star
count break the tie — Artifact Hub's search ordering is not documented as authoritative, so
picking blindly by array position is not safe.

### 2.3 CNCF Landscape: closing a gap AGENTS.md already named

`classifyDerived` (`packages/analyze/src/rules/derived.ts`) has always accepted a `landscape:
LandscapeEntry | null` parameter — `classifyMaturity` checks `landscape?.cncf_level` before
falling back to age/activity bands, `classifyGovernance` checks `landscape?.org_type` before
falling back to `owner_type`. Every caller has always passed `null`. AGENTS.md §6 names this
outright: "`governance` in particular will report `unknown` for most real foundation projects
(etcd-io, containerd, helm, prometheus, cilium) ... until the CNCF landscape crawler ships a
cached seed." This spec ships that seed, as a pass-2 signal rather than a crawler concern — the
data doesn't name new repos (§4.2's crawler-seed removal, ADR 0004, still stands), it enriches
repos already in the corpus, which is exactly what a signal provider is for.

**Source, verified live:** `https://raw.githubusercontent.com/cncf/landscape/master/landscape.yml`
— 1.1 MB of YAML (not JSON, the one provider needing `Provider<T>`'s new `parseBody` hook),
nesting as `landscape: [{category: {subcategories: [{subcategory: {items: [{item: {name,
repo_url, project}}]}}]}}]`. `item.project` is present only for CNCF-hosted entries —
`graduated`/`incubating`/`sandbox`/`archived` (39/37/151/28 entries respectively, at the time
this was checked) — confirmed against `cert-manager` (`project: graduated`, `repo_url:
https://github.com/cert-manager/cert-manager`) and `containerd` (same shape). Everything else in
the file — the vast majority of it, and effectively all of Keco's non-CNCF corpus — carries no
`project` field at all: a directory entry, not a CNCF project.

**`org_type` derivation is a deliberate simplification, not a gap.** The file has no clean
per-item vendor-vs-community signal, but it has an unambiguous foundation signal: any of the
three live `project` levels means the CNCF's TOC now steers the project, which is exactly what
`org_type: 'foundation'` claims. So the provider maps `project ∈ {graduated, incubating,
sandbox} → {cncf_level: project, org_type: 'foundation'}` and nothing else — `archived` (no
longer hosted; `LandscapeEntry.cncf_level` has no slot for it) and every non-CNCF landscape
entry are simply not indexed, exactly as if the repo weren't in the file at all. Distinguishing
"vendor-backed" from "community" for the thousands of non-CNCF landscape entries is not
attempted; those repos keep falling through to `classifyGovernance`'s existing `owner_type`
fallback, same as today.

**Scope boundary:** this closes the `landscape` gap only. It does not add a general "external
links" field to `Analysis` — Artifact Hub and Homebrew already carry their own proof link on
each `install_methods` entry's `source_url`, and a broader "external refs" bundle for the
(not-yet-built) tool page was considered and deliberately deferred rather than shipped ahead of
a consumer that would render it.

### 2.4 What pass 2 does not attempt, and why that's a decision

- **A separate krew-index provider.** Krew's own index has no bulk endpoint — walking it means
  listing `kubernetes-sigs/krew-index`'s `plugins/` directory, which is a second crawl-shaped
  worker, not a signal adapter. Artifact Hub already indexes every krew plugin (confirmed
  above, `kind: 5`), so it's the one registry call this pass needs for that proof.
- **OperatorHub / OLM install commands.** Artifact Hub indexes OLM operators too (`kind: 3`,
  unverified in this pass), but a correct install command needs `operator-sdk` or
  `kubectl operator`, a target namespace, and often a specific catalog source — there is no
  single command shape that's right across operators the way `helm install` and
  `kubectl krew install` are. Fabricating one risks exactly the §6 failure. Left for a
  follow-up that scopes the OLM install flow specifically, not folded in here.
- **"GitHub extra" signals** (contributors, dependents, release cadence, community profile).
  §4.2 is explicit that these calls share the crawler's `GITHUB_QUOTA_CRAWLER_SHARE` budget.
  That's a budgeting contract between two workers, which is a separable piece of design (does
  the analyzer get its own `GitHubClient` instance? does the split move?) and doesn't belong
  bundled into "wire up the signal providers that already exist."

All three are recorded as ROADMAP gaps (§4 below), not silently dropped.

## 3. Pass 3 — structured output the model cannot get wrong

The LLM decides exactly five fields: `summary`, `kind`, `domains`, `confidence`,
`needs_review`. It never touches `runtime`, `license_class`, `openness`, `maturity`,
`governance` or `k8s_relevance` — those stay rule-derived unconditionally, keeping the
rules-first ordering honest (a repo the LLM is unsure about still gets a real, evidence-based
license and maturity, never a guessed one).

**Forced structure, not parsed prose.** The call uses Anthropic's tool-use with
`tool_choice: {type: 'tool', name: 'classify_repo'}`, and the tool's `input_schema` is built
directly from `allValues('kind')` / `allValues('domains')` as JSON-Schema `enum`s — the same
taxonomy file §6 already treats as the single source of truth. This means the model is
*structurally* incapable of returning a `kind` or `domain` that doesn't exist in
`taxonomy.yaml`; there is no free-text parse step that could drift from it. Validation still
runs the result through a zod schema (`LlmVerdict`) for the numeric/string-length bounds a JSON
Schema enum can't express (`confidence` in `[0,1]`, `summary` ≤ 400 chars).

**One retry, then an honest fallback** (§4.2 pass 3, unchanged from the existing doc comment):
invalid output — no tool call, or a `zod` validation failure — gets one retry with the specific
validation error appended to the prompt. A second failure returns `null` to the caller, which
applies exactly the fallback `fallbackAnalysis()` used to hand back standalone:
`kind: 'service'`, `confidence: 0.3`, `needs_review: true`, `domains: ['dev-experience']` if
rules found none. The difference from the old standalone helper: the caller (`analyzeRepo`)
merges this fallback with the rule-derived `runtime`/license/maturity/governance/`k8s_relevance`
and the pass-2 signals already gathered, instead of discarding them — a repo that stumps the LLM
still gets everything pass 1 and pass 2 could prove about it.

**Trigger.** Pass 3 runs when pass 1 leaves the repo *ambiguous*: `confidence < 0.7` (the
existing `CONFIDENCE_THRESHOLD`) **or** `domains` came back empty. The second condition is new
and necessary — `domains` has `min: 1` in `taxonomy.yaml`, so a repo whose topics don't map to
any domain alias would otherwise fail `AnalysisSchema.parse()` outright. Without an
`ANTHROPIC_API_KEY` configured, an ambiguous repo still gets the same honest fallback shape
(`needs_review: true`, `domains` defaulted) rather than silently upgrading a confidence pass 1
never earned.

## 4. ROADMAP.md, AGENTS.md, and what stays open after this

Three items move from ⬜ to ✅: analyzer pass 1 (already true, just unrecorded), pass 2, pass 3.
One stays ⬜ deliberately: **re-analysis triggered by a signal's TTL expiring**, as opposed to a
`content_hash` change. This spec wires the `content_hash`-driven path (the journal's
`RepoFetched{changed:true}`) plus the two manual bypasses the CLI already exposes (`--repo`,
`--min-confidence`); a repo that hasn't changed in a year but whose Scorecard or CNCF Landscape
entry is now stale still won't be picked up automatically. That's its own scan-and-decide worker
loop, not a by-product of this work, and the plan's ROADMAP task records it by name rather than
leaving it implicit.

The two other deferred pieces from §2.4 — a real krew-index/OperatorHub provider, and the
GitHub-extra signal sharing the crawler's quota — are recorded the same way.

**AGENTS.md §6 changes too, not just ROADMAP.** Its "Unknown is a real answer" paragraph names
the exact gap §2.3 closes — governance defaulting to `unknown` for etcd-io/containerd/helm/
prometheus/cilium "until the CNCF landscape crawler ships a cached seed." That sentence stops
being true once this ships, and §15's definition of done requires updating AGENTS.md when a
contract it describes changes — this is one, so the plan's docs task edits both files together
rather than letting AGENTS.md drift from what's actually built.

## 5. What this spec does not change

- `AnalysisSchema` and `ToolDocument` (`packages/core/src/schemas.ts`) — no field changes. Every
  field pass 2/3 populate (`signals`, `install_methods`, `signals_used`, `partial_signals`,
  `method`, `model`) already exists in the schema; this spec is only what fills them in. The one
  addition to `packages/core/src/schemas.ts` is `LandscapeEntry` itself (moved there from
  `packages/analyze`, §2.3) — a new exported type, not a new field on either document.
- The CLI surface (`kecoctl repo analyze`, its three options) — already built, described in
  §0.
- The projector — out of scope; it reads `analysis/**`, which this spec starts populating for
  real, but building `tools` documents from it is separate, already-tracked work.

**Plan:** `docs/superpowers/plans/2026-09-08-analyzer-implementation.md`.
