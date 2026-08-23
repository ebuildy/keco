# Portal mock backend for development and test — design

Date: 2026-08-23
Status: implemented

## The governing invariant

**The mock exists for development and testing only. It never ships in a production build.**

This is not a guideline, an intention, or a property of how the mock is normally invoked. It is
the constraint every other decision in this document is subordinate to. Where fidelity,
convenience or simplicity conflict with it, it wins.

Concretely, all of the following must hold, and each is enforced independently in
"Keeping the mock out of production" below:

- No production artifact — `dist/`, or anything served by `apps/api` — contains mock corpus
  data, the mock engine, MSW, or the MSW service worker script.
- No application module imports from `src/mocks/`. The only sanctioned consumers are the
  dev-only branch in `main.tsx` and test files.
- No runtime flag, environment variable or misconfiguration can activate the mock in a
  production build, because the code is not present to activate.
- MSW is a `devDependency` and never a `dependency`.

A mock corpus reaching production would serve fabricated repositories, fabricated scores and —
worst of all — fabricated `install_methods` commands to real readers. §6 names a wrong
`brew install` line as the worst bug this project can ship, because people paste these into a
terminal. Every layer below exists to make that outcome unreachable rather than unlikely.

## Problem

The portal cannot be developed without a crawled corpus, and there is no way to obtain one
cheaply. `apps/web` has exactly two data dependencies, and both are empty on a fresh clone:

- **Meilisearch `tools`**, queried straight from the browser with the search-only key
  (`src/lib/meili.ts`, `src/lib/search.ts`) — search, facet distributions, momentum, and
  single-document lookup.
- **`GET /api/readme/{owner}/{repo}`** from `apps/api` (`src/routes/tool.tsx`), which reads
  `.cache/repos/{owner}/{repo}/readme.md` by key and returns sanitised HTML.

Filling either one today means a `GITHUB_TOKEN`, a discovery sweep, a crawl, an analyzer pass
and a projector run — hours of wall time and real GitHub quota — before a single card renders.
The only committed fixtures are six analyzer *inputs* in `packages/analyze/fixtures/`, which are
write-model shaped and cannot reach a read surface.

The consequence is that frontend work on the ROADMAP v1 read-side items — facet sidebar,
keyboard navigation, install tabs, styling — has no substrate. A developer opening the portal
sees an empty index and an error banner.

This design gives the portal a believable corpus and a working README endpoint with no
infrastructure, no network and no GitHub quota, while keeping the mock strictly out of the
shipped bundle.

## Scope

**In:**

- A mock corpus of `ToolDocument`s: ~30 hand-written entries for real projects, plus a
  deterministic generator padding to ~300.
- A pure query engine implementing the subset of the Meilisearch search API the portal
  actually uses — the filter grammar `buildFilters()` emits, the sorts `sortSpec()` emits,
  facet distribution, and pagination.
- MSW handlers binding that engine to the three HTTP surfaces the portal calls.
- README fixtures served as pre-sanitised HTML on `/api/readme/{owner}/{repo}`.
- Dev-only activation behind `VITE_MOCK=1`, a `mise run web:mock` task, and the tests that
  keep the mock from drifting away from the read model.
- The five enforcement layers that hold the governing invariant: the `import.meta.env.DEV`
  guard, `msw` as a `devDependency`, an `eslint` rule barring imports of `src/mocks/**` outside
  `main.tsx` and test files, an `assert-no-mocks` scan of `dist/` wired into `mise run build`,
  and a gitignored MSW worker script.

**Out, deliberately:**

- **Every other `/api/*` route.** `/api/v1`, `/api/mcp`, `/api/chat`, `/api/admin/*` and
  `/api/commands/*` are not mocked. The portal does not call them (§9: the browser queries
  Meilisearch directly), so mocking them would be inventing a contract nobody consumes.
- **`apps/backoffice`.** It does not exist (§0). When it does, it reads `repos_state`, a
  different index with a different shape, and it gets its own decision.
- **Any write path.** The mock is read-only, like the surface it stands in for.
- **Auto-fallback when Meilisearch is unreachable.** Explicitly rejected; see below.
- **A mock for `apps/api` itself, or for `apps/web/prerender`.** The prerender is a Node build
  step reading the real read model through `@keco/query`; it is unaffected and stays that way.

## Decisions

### Interception in the browser, not a seeded backend

The considered alternative was to ship fixture cache entries (`repos/**` + `analysis/**`) and
run the real projector into a local Meilisearch, keeping every component genuine. That has
strictly better fidelity and fits §2 exactly.

It was not chosen because it does not remove the infrastructure requirement: it still needs
`mise run infra:up`, a Docker daemon, a Meilisearch container and a projector run before the
first card renders. The goal here is a portal that works from `pnpm install` alone.

The cost of that choice is fidelity, and it is real: the mock's relevance ordering, facet counts
and filter semantics are an approximation of Meilisearch's, and an approximation can disagree
with production in exactly the places a search portal cares about. Two things bound the damage:

1. **The grammar is closed and small.** `buildFilters()` can emit only three forms —
   `attribute IN ["a", "b"]`, `archived = false`, and `k8s_relevance >= n` — and `sortSpec()`
   only four `field:desc` specs. This is not a general Meilisearch implementation; it is an
   evaluator for a finite, enumerable input set, and a test can assert it covers all of it.
2. **Interception is at the network layer.** No application code branches on mock mode, so the
   mock always answers the request the portal genuinely issues. A change to the portal's query
   cannot silently bypass the mock — it produces an unhandled request, which is an error.

What the mock is therefore **not** trusted for: judging relevance ranking, tuning
`searchableAttributes` weights, or validating a filter expression before it reaches production.
Those need real Meilisearch. It is trusted for layout, states, interaction, and volume-dependent
behaviour like pagination and facet rendering.

### Curated documents plus deterministic padding

Thirty hand-written documents make the portal legible — a reviewer can tell whether a card,
a score breakdown or an install block looks right only if it describes something they recognise.
Three hundred generated ones make it exercisable: pagination, deep-paging limits, facet counts
large enough to sort and truncate, and a momentum distribution with a real tail.

The generator is seeded and deterministic, so the corpus is identical on every run and in every
checkout. A diff in rendered output means someone changed the generator, not that the fixtures
drifted.

Curated `install_methods` entries are only written where the registry entry genuinely exists,
with the real `source_url`. §6 calls a fabricated `brew install` line the worst bug this project
can ship, and a fixture that teaches a developer the wrong shape is how one gets written.

### Activation is explicit, and auto-fallback is rejected

Mock mode is `VITE_MOCK=1`, read only inside an `import.meta.env.DEV` guard.

The rejected alternative was probing Meilisearch on boot and switching to mocks when it is
unreachable. It is more convenient and it is wrong: it makes a genuine outage, a missing
`VITE_MEILI_SEARCH_KEY` and a deliberately mocked session indistinguishable from inside the
application. `searchErrorMessage()` in `src/lib/search.ts` already goes out of its way to
separate a 401 misconfiguration from an outage precisely because collapsing those two states
hides a build-time bug behind what looks like an incident. Silently substituting fake data is
the same failure, one step worse.

### The mock lives inside `src/`

`apps/web/prerender/` sits outside `src/` because it is Node build tooling, and
`eslint.config.mjs` scopes the browser-bundle import rule to `apps/web/src` for exactly that
reason (§7).

The mock is the opposite case: it runs in a browser. Placing it under `src/mocks/` puts it under
the rule that bars `node:*`, `@keco/cache`, `@keco/github`, `@keco/signals` and `@keco/analyze`
from browser code, which is the correct constraint for it.

### README fixtures are HTML, not markdown

The real route returns `{ repo, html, truncated }`, where `html` has already been through
rehype-sanitize and Shiki server-side. §9 and §14 are emphatic that rendering untrusted README
markdown in the browser is a stored-XSS hole across the whole corpus.

The mock therefore stores pre-authored, already-safe HTML fragments. This matches the response
contract exactly, keeps the markdown pipeline out of the dev bundle, and means the fixture
cannot become a worked example of the pattern the architecture forbids.

## Architecture

```
main.tsx
  └─ if (import.meta.env.DEV && VITE_MOCK === '1')
       await import('./mocks/start')     ← dynamic; absent from production bundles
            └─ setupWorker(...handlers)

  browser fetch                MSW service worker              mocks/
  ─────────────────────────────────────────────────────────────────────────────
  POST {MEILI_HOST}/indexes/tools/search      ─▶ handlers ─▶ engine ─▶ corpus
  GET  {MEILI_HOST}/indexes/tools/documents/:id ─▶ handlers ─▶ corpus
  GET  /api/readme/:owner/:repo               ─▶ handlers ─▶ readmes
```

No application module imports anything from `mocks/`. The dependency runs one way only:
`main.tsx` conditionally starts the worker, and the worker answers requests the unchanged
application makes.

### Intercepted surfaces

| Request | Portal callers |
|---|---|
| `POST {VITE_MEILI_HOST}/indexes/tools/search` | `searchTools`, `browseFacets`, `whatsHot`, `findAlternatives` |
| `GET {VITE_MEILI_HOST}/indexes/tools/documents/:id` | `getTool` |
| `GET /api/readme/:owner/:repo` | the tool page's README panel |

`VITE_MEILI_HOST` defaults to `http://localhost:7700` in `meili.ts`, and the handlers derive
their pattern from the same variable so a developer who has pointed it elsewhere still gets
interception.

## Components

All paths relative to `apps/web/src/mocks/`.

### `corpus/curated.ts`

~30 `ToolDocument` values for real, recognisable projects — argo-cd, cilium, k9s, helm,
cert-manager, kubectx, external-secrets, and similar — chosen to span `kind`, `domains`,
`runtime`, `maturity` and `governance` rather than to be a top-30 list.

Requirements on the data:

- Every document satisfies `ToolDocument` from `@keco/core`.
- Taxonomy values are real values from `taxonomy.yaml`, including `unknown` where that is the
  honest answer (§6) — some documents must carry `governance: 'unknown'`, because most real
  foundation projects do today.
- `score.quality_coverage` varies, and at least one document has a low coverage with a high
  quality score, so the UI's obligation to distinguish them (§4.4) is visible in dev.
- At least one archived document, one with `needs_review: true`, one with no
  `install_methods`, and one with `signals.scorecard: null`.

### `corpus/generate.ts`

A deterministic seeded PRNG (a small xorshift or mulberry32, written inline — no dependency)
producing documents up to a configured total, default ~300. Names are synthetic and obviously
so. Values are drawn from the taxonomy file, so a new family or value is populated
automatically rather than needing an edit here.

### `corpus/index.ts`

Assembles curated + generated once, memoised, and exports the array.

### `engine.ts`

A pure function over `(corpus, request) => response`, with no MSW import. This is the module
that carries the fidelity risk, so it is the module that gets tested.

It implements:

- **Filters** — the three forms `buildFilters()` emits, ANDed. `IN` resolves nested
  `install_methods.method` and `score.*` paths by dotted lookup, matching
  `familyAttribute()`.
- **Query matching** — case-insensitive substring over `name`, `full_name`, `summary`,
  `description`, `github_topics`, `readme_excerpt`, in that priority order; an empty query
  matches everything. This approximates relevance; it does not reproduce it, and the spec says
  so out loud.
- **Sorting** — `stars:desc`, `score.total:desc`, `score.momentum:desc`, `pushed_at:desc`.
  With no sort, results are ordered by match priority then `score.total:desc`.
- **Facets** — count per value for each requested attribute, computed over the filtered set,
  matching Meilisearch's `facetDistribution` semantics.
- **Pagination** — `page` / `hitsPerPage`, returning `hits`, `page`, `totalHits`,
  `totalPages`, `processingTimeMs`, clamped at `MAX_TOTAL_HITS`.

### `readmes.ts`

`Record<string, { html: string; truncated: boolean }>` keyed by `full_name`, covering the
curated documents. Generated documents intentionally have no entry: a missing README is an
ordinary state before the crawler reaches a repo, the tool page already handles it, and dev
should show that path regularly. The handler answers 404 for a miss, as the real route does.

### `handlers.ts`, `browser.ts`, `start.ts`

Thin MSW wiring. `start.ts` exports `startMocks()`, which registers the worker with
`onUnhandledRequest: 'error'` and logs a one-line banner naming the corpus size, so mock data
is never mistaken for a real index.

## Keeping the mock out of production

Five independent layers. Any one of them alone would usually be sufficient; the invariant is
important enough that a single failure must not be enough to breach it.

### Layer 1 — activation, and static elimination

```ts
// main.tsx, before render
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  await (await import('./mocks/start')).startMocks();
}
```

`import.meta.env.DEV` is replaced with the literal `false` by Vite in any production build, so
Rollup eliminates the branch as dead code and the dynamic `import()` with it. Nothing reachable
from `./mocks/start` — corpus, engine, handlers, MSW — is emitted into a production chunk.

The `DEV` check is first and is not optional: `VITE_MOCK` alone would be a runtime flag, and a
runtime flag is something an environment can set. `import.meta.env.DEV` is decided at build
time and cannot be. `VITE_MOCK` is therefore only ever a second condition narrowing an already
dev-only branch, never the thing that gates production behaviour.

`.env.example` gains `VITE_MOCK`, with a comment naming the surface that reads it (§12) and
stating that it has no effect outside `vite dev`.

### Layer 2 — the dependency is dev-only

`msw` is added to `devDependencies` and never to `dependencies`. A production install does not
contain it, so even a build that somehow retained the import would fail to resolve rather than
succeed quietly.

### Layer 3 — lint bars importing the mock from application code

`eslint.config.mjs` already encodes the §7 import boundaries as rules, and this is one more
line of the same contract. A `no-restricted-imports` rule bars any import of `src/mocks/**`,
with exactly two exemptions:

- `apps/web/src/main.tsx` — the dev-only branch above.
- test files (`**/*.test.ts`, `**/*.test.tsx`) — the sanctioned test consumer.

This is what makes "dev **and test** only" true rather than aspirational: the mock corpus and
engine are legitimate fixtures for the portal's own tests, and illegitimate everywhere else. A
component or route that imports the corpus to render something fails lint, which fails
`mise run ci`.

### Layer 4 — the build asserts it, rather than assuming it

Static elimination is a property of the bundler's behaviour, and bundler behaviour changes
across major versions. So the build verifies the outcome instead of trusting the mechanism.

`apps/web/scripts/assert-no-mocks.mjs` scans the built `dist/` for a sentinel string that
appears only in the mock corpus module, plus the strings `mockServiceWorker` and `msw`, and
exits non-zero on any hit. It runs as the final step of `mise run build`, after `vite build`
and the prerender, so a regression fails the build rather than shipping.

This is the layer that actually holds the invariant. The other four describe intent; this one
measures the artifact.

### Layer 5 — the generated worker script is gitignored and swept before every build

MSW needs its worker script served from the web root, and `vite build` copies `public/`
verbatim into `dist/` — regardless of `DEV` or `VITE_MOCK`. So `apps/web/public/mockServiceWorker.js`
is **generated by `msw init` as a step of the `web:mock` task and gitignored**, never committed.
That keeps it out of a clean checkout, a CI checkout and a deployment build. It does *not* keep
it out of a subsequent `mise run build` on a machine that has already run `mise run web:mock` —
gitignore has no effect on a file already sitting in the working tree, so `vite build` copies it
into `dist/` just as it would any other generated asset. `mise run build` therefore removes the
file before building, as routine hygiene rather than an enforcement mechanism. Layer 4's scan is
the actual backstop: it catches the worker whether it survived the gitignore, the pre-build
removal, or some future step that reintroduces it.

## Preserving the invariant

Two changes would breach it, and both must be refused:

- **Making the mock available in a production build "for demos" or "for a staging
  environment".** A demo corpus is a separate decision with its own design — a real deployment
  reading a real index seeded with real data — not a flag on the dev mock. Fabricated data
  behind a public URL is the failure mode §6 exists to prevent.
- **Importing corpus fixtures into application code** to seed an empty state, a loading
  skeleton or a Storybook-like preview. Layer 3 blocks it; if a placeholder is needed, it gets
  written as a placeholder in application code, plainly labelled, not borrowed from the mock.

If either is ever genuinely wanted, it reverses a decision recorded here and gets an ADR (§13),
not a quiet edit.

## Error handling

Loud, never degrading, for the reason given under Decisions:

- `onUnhandledRequest: 'error'` — a portal request the mock does not cover fails visibly rather
  than falling through to a real or absent backend.
- Worker registration failure throws; it does not silently continue with live requests.
- A console banner on every start.
- `VITE_MOCK=1` in a non-dev build does nothing at all, because the branch does not exist.

## Testing

Vitest in the node environment, against the pure engine — no browser, no service worker.

- **`corpus.test.ts`** — every curated and every generated document passes `ToolDocument.parse`.
  This is the drift guard: change the read-model schema and the fixtures fail immediately
  instead of rendering something impossible.
- **`engine.test.ts`** — filtering per form, sorting per spec, facet counts against
  hand-computed expectations, pagination boundaries, empty query, zero results, and the
  `MAX_TOTAL_HITS` clamp.
- **`engine.pinning.test.ts`** — driven by the taxonomy file and the `SortKey` union, asserting
  the engine handles every attribute `defaultFacets()` can name and every spec `sortSpec()` can
  emit. Adding a taxonomy family fails this test, in the same spirit as
  `packages/analyze/src/rules/pinning.test.ts`.
- **`handlers.test.ts`** — the request/response mapping for the three surfaces, including the
  README 404 path.

These tests are also the second sanctioned use of the mock: the corpus and engine are the
portal's test fixtures, which is why Layer 3 exempts test files rather than confining the mock
to `main.tsx` alone. A route or component test that needs a realistic `ToolDocument` should
take it from the curated corpus instead of hand-rolling one that can drift from the schema.

The invariant gets its own coverage, because a guard nobody tests is a guard that quietly
stops working:

- **`assert-no-mocks` is exercised by `mise run build`**, which runs a production `vite build`
  and then scans the resulting `dist/` before the build can succeed. There is no CI in this
  repo (`mise run ci` is `check` + `lint` + `test` + `taxonomy:check`, and none of those build);
  the scan's only enforcement point today is a local `mise run build`, so a change that never
  gets built locally before merge would not be caught by it. A green run is evidence about the
  artifact, not about the config.
- **A negative test** asserts the scanner actually fails when it should: point it at a fixture
  directory containing the sentinel and require a non-zero exit. Without this, a scanner with a
  broken glob passes forever and proves nothing.

`mise run ci` must be green (§15.1). No write-side, read-model or API contract changes are
involved, so §15.2–§15.4 do not apply; §15.5 holds unchanged, and the prerender is untouched.

## Documentation

- CLAUDE.md §8 gains a `mise run web:mock` row, stating in the description that it is
  dev-only.
- CLAUDE.md §14 ("Things that will bite you") gains a line under the frontend group: the mock
  is dev and test only, it is kept out of production by the layers above, and adding a
  production path to it needs an ADR. §14 already warns that `VITE_`-prefixed variables are
  baked into the shipped bundle; this sits directly beside it.
- `apps/web/README.md` gains a short section: what the mock covers, what it does not, the
  explicit warning that relevance ordering and filter semantics are approximations not to be
  trusted for production behaviour, and the invariant stated plainly.
- ROADMAP.md gains the item under the read-side v1 work.
