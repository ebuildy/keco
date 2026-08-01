# Taxonomy as YAML — design

Date: 2026-08-01
Status: approved, not implemented

## Problem

The classification vocabulary is hard-coded as zod enums in `packages/core/src/taxonomy.ts`,
carries no human-readable descriptions, and covers only three axes (`kind`, `domains`,
`install_methods`). The portal has nothing to browse by: the home page offers a search box and a
momentum list, and a visitor who does not already know what to type gets nothing.

Three things follow from that:

- Values have no descriptions, so nothing can explain what `cost` or `crd-library` means — not
  the portal, not the LLM prompt in analyzer pass 3, not the MCP tool schemas.
- Adding a value means editing TypeScript, which puts vocabulary changes behind a code review of
  code rather than of data.
- Whole families of useful facets — licence, openness, maturity, governance — are absent, though
  every input they need is already in the cache.

## Decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Source of truth | `taxonomy.yaml`, parsed and zod-validated at runtime | codegen to TS; TS-canonical with YAML for display only |
| `kind` vs `deployment` | three orthogonal axes: `kind`, `runtime`, `install_methods` | a `deployment` family overlapping `kind`; folding it into `install_methods` |
| Derived families | all four: `license_class`, `openness`, `maturity`, `governance` | — |
| Home page | chips with facet counts linking to `/search` | per-topic landing pages under `/t/`; featured-families layout |
| Read-model shape | one flat field per family | a single namespaced `labels[]` array; both |

The runtime-loaded YAML costs the literal union types: `Kind` and `Domain` become `string`, so
exhaustiveness checking and typo detection at compile time are gone. That is a deliberate trade,
mitigated by a pinning test (below) rather than by types.

## The file

`packages/core/taxonomy.yaml`, one document.

```yaml
version: 1
families:
  - id: domains
    label: Domain
    param: domain              # the URL query parameter this family uses
    description: What problem the tool solves.
    cardinality: many          # one | many
    min: 1                     # optional, cardinality: many only
    max: 3                     # optional, cardinality: many only; absent means unbounded
    source: analyzer           # analyzer | derived | registry
    facet: true                # renders as a home-page chip row
    values:
      - id: security
        label: Security
        description: Scanning, RBAC, admission control, supply-chain and runtime security.
        aliases: [security, rbac, container-security, trivy]
      - id: unknown
        label: Unknown
        description: Not enough evidence to classify.
        hidden: true           # never rendered as a chip
```

`aliases` carries the mapping from an external identifier to a value id — a GitHub topic for
`domains`, an SPDX identifier for `license_class`. It replaces the `DOMAIN_TOPICS` map currently
hard-coded in `packages/analyze/src/rules/kind.ts`. Structural detection (tree paths, manifest
greps, name patterns) stays in TypeScript: those are code, not vocabulary.

### Families

| Family | Cardinality | Source | Values |
|---|---|---|---|
| `kind` | exactly 1 | analyzer | the 14 existing values, unchanged |
| `domains` | 1–3 | analyzer | the 18 existing values plus `database`, `secrets`, `scheduling`, `serverless` |
| `runtime` | exactly 1 | analyzer | `in-cluster` · `workstation` · `ci-pipeline` · `in-your-code` · `cluster-itself` · `hosted-service` · `unknown` |
| `install_methods` | 0–n | registry | the 17 existing values, unchanged |
| `license_class` | exactly 1 | derived | `permissive` · `weak-copyleft` · `copyleft` · `source-available` · `public-domain` · `unknown` |
| `openness` | exactly 1 | derived | `fully-open` · `open-core` · `source-available` · `unknown` |
| `maturity` | exactly 1 | derived | `cncf-graduated` · `cncf-incubating` · `cncf-sandbox` · `established` · `young` · `dormant` · `archived` · `unknown` |
| `governance` | exactly 1 | derived | `foundation` · `vendor-backed` · `community` · `individual` · `unknown` |

`install_methods` keeps its existing shape — an array of `{ method, command, source_url,
verified_at }` — and remains the only family requiring proof that the entry exists in a registry.
The YAML declares its vocabulary and descriptions; it does not change how entries are produced.

`language` and `owner` stay plain filterable fields. They are facts about a repository, not a
closed vocabulary, and they cannot be described in advance.

### New domain values

- `database` — data stores and their operators. Postgres, MySQL, Redis, Mongo, Kafka and NATS
  operators currently land in `storage`, which is meant for CSI drivers and volume management.
  This is the largest mis-binned cluster in the corpus.
- `secrets` — external-secrets, sealed-secrets, Vault integrations. Large and self-contained;
  `security` currently swallows it.
- `scheduling` — Kueue, Volcano, descheduler, bin-packing. Nothing fits today: `autoscaling` is
  about capacity, not placement.
- `serverless` — Knative, OpenFaaS and the event-driven runtimes. No home today.

Not added, deliberately: `compliance` (covered by `security` plus `policy`; a third overlapping
bucket makes all three worse) and `messaging` (Kafka and NATS operators go to `database` as data
infrastructure — one bucket rather than two blurry ones).

### Two schema rules

1. Every family that can fail to classify — the four `derived` families and `runtime` — declares
   an `unknown` value, and it is the default. Absence of evidence never becomes a positive claim,
   the same rule §4.2 of `CLAUDE.md` already applies to a missing Scorecard. `kind` and `domains`
   have no `unknown`: `kind` already falls back to `service` with a low confidence and
   `needs_review`, and `domains` requires at least one value.
2. Values marked `hidden: true` never render as a chip. `unknown` is always hidden.

### URL parameters

Each family declares the query parameter it uses, because the family id and the parameter differ
where a plural reads badly: `domains` → `domain`, `install_methods` → `install`. Every other
family uses its own id. The generic filter loop in `@keco/query` and the chip links both read
`param` from the file, so the two cannot disagree.

### Naming collision

`ToolDocument.topics` already means *GitHub* topics and is a `searchableAttribute`. It is renamed
`github_topics` so that "topic" is not two things. This is a read-model change: re-project and
swap, no crawl.

## Wiring

```text
taxonomy.yaml ──┬──▶ @keco/core (load + zod validate at module init, fail fast)
                │        │
                │        ├──▶ @keco/analyze   rules use `aliases`, verdicts validated
                │        ├──▶ @keco/search    filterableAttributes derived from families
                │        ├──▶ @keco/query     facet list + filter builder derived
                │        └──▶ apps/web        labels and descriptions for the chips
```

The YAML is a static declaration read by both sides. It is not a read model, so no CQRS boundary
is crossed.

### `packages/core`

`taxonomy.ts` becomes a loader. It reads the YAML sitting next to it with `fs` and the `yaml`
package, validates it against a `TaxonomyFile` zod schema, and throws at module load on malformed
input, an unknown `source` or `cardinality`, a duplicate family id or `param`, a duplicate value
id within a family, a `derived` family with no `unknown` value, `min` or `max` on a
`cardinality: one` family, or `min` greater than `max`. `min` and `max` are both optional on a
`cardinality: many` family: `install_methods` declares neither and is unbounded.

Exports:

```ts
TAXONOMY: Family[]                        // whole file, in declared order
family(id): Family                        // throws on unknown family
values(familyId): Value[]                 // visible values only
allValues(familyId): Value[]              // including hidden
isValue(familyId, id): boolean
aliasesFor(familyId): Map<string, string> // external identifier → value id
facetableFamilies(): string[]             // families with facet: true
taxonomyForClient(): Family[]             // plain JSON, safe to pass as props
```

`Kind`, `Domain` and `InstallMethod` become `string`. The zod schemas in `schemas.ts` validate
against the loaded file with `z.string().refine(v => isValue('kind', v))` rather than `z.enum`.

The web app must be able to read the file at runtime. `next.config.ts` gains an
`outputFileTracingIncludes` entry for `packages/core/taxonomy.yaml` so the standalone build ships
it. Client components never read the file: the home page and search page are server-rendered and
pass `taxonomyForClient()` output down as props.

### `packages/core/src/schemas.ts`

`AnalysisSchema` and `ToolDocument` both gain `runtime`, `license_class`, `openness`, `maturity`
and `governance`, each `z.string().refine(...)` against its family. `topics` is renamed
`github_topics` in `ToolDocument`.

### `packages/analyze`

- `classifyDomains` reads `aliasesFor('domains')` instead of the hard-coded `DOMAIN_TOPICS` map.
- New `rules/runtime.ts`, structural and ordered strongest-first: `Chart.yaml` or `config/crd/`
  ⇒ `in-cluster`; `.krew.yaml`, or `cmd/` with cobra ⇒ `workstation`; `action.yml` at the root
  ⇒ `ci-pipeline`; a library manifest with no `cmd/` ⇒ `in-your-code`; `kind: distribution`
  ⇒ `cluster-itself`; otherwise `unknown`.
- New `rules/derived.ts`:
  - `license_class` — SPDX id from the cached `repo.json`, mapped through `aliasesFor('license_class')`.
  - `openness` — `fully-open` only on positive evidence: an OSI licence **and** no enterprise
    marker (`ee/` or `enterprise/` path, "Enterprise Edition" in the README). A source-available
    licence ⇒ `source-available`. An OSI licence with enterprise markers ⇒ `open-core`.
    Everything else ⇒ `unknown`.
  - `maturity` — CNCF level from the cached landscape seed; otherwise `archived` from the GitHub
    flag, `dormant` with no push in 12 months, `young` under a year old, `established` over two
    years old with a release in the last six months, else `unknown`.
  - `governance` — `foundation` when the owner org appears in the CNCF landscape or is a
    Kubernetes SIG org; `vendor-backed` when the owner org maps to a known vendor;
    `individual` for a user account; `community` for an org account with a spread of
    contributors; else `unknown`.

All of this is analyzer work, not projector work: it is classification derived from cached data,
so the projector stays pure (§4.3). Deriving these in the analyzer also means they are recomputed
by a replay with no network calls.

### `packages/search`

`filterableAttributes` gains `runtime`, `license_class`, `openness`, `maturity`, `governance`;
`searchableAttributes` renames `topics` to `github_topics`. A settings change means a new index
and an alias swap, never a mutation of the live alias.

### `packages/query`

`SearchParams` gains the five new families. The per-family `inList(...)` calls collapse into a
loop over `TAXONOMY`, so adding a family later requires no change here. The default `facets` list
comes from `facetableFamilies()`.

### `apps/web`

The home page adds one call:

```ts
const facets = await searchTools(query, { hitsPerPage: 0, facets: facetableFamilies() });
```

`hitsPerPage: 0` returns the facet distribution without hits. Each facetable family renders as a
row: the family label, then its values sorted by count descending, capped at 12 with a "more →"
link into `/search`. A chip is a plain `<a href="/search?domain=security">` with the YAML
description as its `title`, so the page works with JavaScript disabled (§15.5). Values absent
from the distribution do not render, so an empty category is invisible rather than a dead link.
`revalidate = 900` is unchanged and no request-scoped API enters the route.

The search page reads the five new parameters from the URL
(`?runtime=&license_class=&openness=&maturity=&governance=`) through the same generic loop, so
the facet sidebar and the home page cannot drift apart.

## Failure behaviour

- A malformed or self-inconsistent YAML throws at module load. Every worker and the web app fail
  immediately and loudly rather than classifying into a vocabulary that does not exist.
- A value produced by a rule or by the LLM that is absent from the file is rejected by
  `AnalysisSchema.parse`, which is the existing retry-once-then-fallback path of §4.2.
- A missing CNCF landscape seed degrades `maturity` and `governance` to `unknown` and records the
  provider in `partial_signals[]`. It never blocks an analysis.

## Testing

- Loader: a valid file parses; a duplicate value id throws; an unknown family id throws; every
  `derived` family has an `unknown` value; `cardinality: many` requires `max`.
- **Pinning test** — every `kind` and `domain` literal appearing in any rules table exists in the
  YAML. This is what replaces the compile-time union check, and it is the reason the type trade
  is acceptable.
- Rules: `runtime` and each derived classifier against `packages/analyze/fixtures/*.json`. §13
  requires a fixture per new rule. The four existing fixtures cover several cases; new fixtures
  are needed for an open-core repo, a BUSL-licensed repo, and a CNCF-graduated repo.
- Query: the generic filter builder emits the same Meilisearch filter strings the hand-written
  version did.
- Home page: renders the expected chips from a stubbed facet distribution.

## Migration

No re-crawl. `mise run replay -- --consumer analyzer`, then `mise run rebuild`. The new families
are computed from the cache with zero GitHub calls, and the read model is promoted by an alias
swap — exactly what §15.3 requires.

## Also updated

`docs/taxonomy.md` (the vocabulary now lives in the YAML; adding a value becomes a YAML edit plus
a rule plus a fixture), `CLAUDE.md` §6, and a `mise run taxonomy:check` task that validates the
file standalone, wired into `mise run ci`.

## Out of scope

- `/t/{family}/{value}` landing pages — chips link straight to `/search`.
- A taxonomy editor in the backoffice. §10 is explicit: the fix belongs in the analyzer's rules,
  where it improves every repo instead of one.
- Icons, colours or translated labels.
- Any change to scoring. The new families are filters, not score inputs.

## Risk

`openness` is the family most likely to make a wrong public claim about someone's project. The
rule promotes to `fully-open` only on positive evidence and leaves everything else `unknown`. If
that proves noisy against real data, the response is a stricter rule, not backfilled guesses.
