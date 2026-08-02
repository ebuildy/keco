# Taxonomy in YAML — a guide for humans

Companion to [the design spec](./2026-08-01-taxonomy-yaml-design.md). The spec records *what we
decided and why*; this explains *how it works and how to change it*.

For a developer or someone running this in production. You don't need to have read the spec.

---

## Why we did this

Keco sorts Kubernetes projects into buckets so you can browse them: is it a CLI or an operator,
does it do networking or security, can you `brew install` it.

Those buckets used to be a hard-coded list in a TypeScript file:

```ts
export const KINDS = ['cli', 'kubectl-plugin', 'operator', ...] as const;
```

Three problems with that:

1. **No descriptions.** `cost` meant nothing to anyone who hadn't read the source. The portal
   couldn't explain it, and neither could the AI that classifies ambiguous repos.
2. **Changing the vocabulary meant changing code.** Adding a category was a code review about
   code, when it should be a review about data.
3. **Only three axes existed** — what it is, what it solves, how you install it. We had no way
   to say "this runs in your cluster" or "this is open-core" even though we already had the
   data sitting in the cache.

And the home page was a search box with nothing to browse. If you didn't already know what to
type, Keco gave you nothing.

---

## What changed

One file — `packages/core/taxonomy.yaml` — now declares the whole vocabulary: **8 families,
83 values**, each with a human-readable label and description.

| Family | How many per tool | Who decides it | Example |
|---|---|---|---|
| `kind` | exactly 1 | analyzer rules | `operator` |
| `domains` | 1 to 3 | analyzer rules | `security`, `policy` |
| `runtime` | exactly 1 | analyzer rules | `in-cluster` |
| `install_methods` | any number | proven against a registry | `helm`, `krew` |
| `license_class` | exactly 1 | derived from the SPDX id | `permissive` |
| `openness` | exactly 1 | derived from licence + repo contents | `fully-open` |
| `maturity` | exactly 1 | derived from CNCF status, age, activity | `cncf-graduated` |
| `governance` | exactly 1 | derived from CNCF landscape + account type | `foundation` |

Four families are new (`runtime`, `license_class`, `openness`, `governance`), plus `maturity`.
Four new domains were added: `database`, `secrets`, `scheduling`, `serverless`.

**On the home page** you now get a row of clickable chips per family, with live counts, linking
into search. Chips are plain links — the page works with JavaScript off.

For *why* the vocabulary is shaped this way (why three axes instead of one, why `unknown` is a
real answer), read [`docs/taxonomy.md`](../../taxonomy.md).

---

## How it fits together

The YAML is read once when the process starts, validated, and then everything else derives from
it. Nothing downstream hard-codes a family name.

```
                    packages/core/taxonomy.yaml
                              │
                    read + validated at startup
                              │
        ┌─────────────┬───────┴───────┬──────────────┐
        ▼             ▼               ▼              ▼
   @keco/analyze  @keco/search   @keco/query     apps/web
   classifies     which fields   builds search   renders the
   each repo      are filterable filters/facets  browse chips
```

The practical consequence: **adding a value is a YAML edit.** Nothing in `@keco/search`,
`@keco/query` or the portal needs touching — they all loop over whatever the file declares.

### Where a repo actually gets classified

```
GitHub ──▶ crawler ──▶ cache ──▶ analyzer ──▶ analysis/*.json ──▶ projector ──▶ Meilisearch ──▶ portal
                                    │
                          reads taxonomy.yaml
                          to know the vocabulary
```

The analyzer does three passes, cheapest first:

1. **Local rules** — free, no network. File-tree and manifest checks: a `Chart.yaml` means Helm
   chart, a `.krew.yaml` means kubectl plugin, `k8s.io/client-go` in `go.mod` means it talks to
   the API. This settles most repos.
2. **External signals** — OpenSSF Scorecard, deps.dev, registries. All cached with a TTL.
3. **AI fallback** — only for what's still ambiguous, and only ever returning values the YAML
   declares.

Everything in this change is pass 1: deterministic, free, and reproducible from the cache.

---

## The file format

```yaml
version: 1

families:
  - id: domains              # used in code and as the Meilisearch field name
    label: Domain            # what a human sees
    param: domain            # the URL query parameter: /search?domain=security
    description: What problem the tool solves.
    cardinality: many        # "one" or "many"
    min: 1                   # optional, "many" only
    max: 3                   # optional, "many" only; absent means unlimited
    source: analyzer         # analyzer | derived | registry
    facet: true              # show as a chip row on the home page
    values:
      - id: security
        label: Security
        description: Scanning, RBAC, admission control, supply-chain and runtime security.
        aliases: [security, rbac]   # GitHub topics that map here

      - id: unknown
        label: Unknown
        description: Not enough evidence to classify.
        hidden: true         # never shown as a chip
```

**`aliases` are the useful bit.** For `domains` they're GitHub topics — a repo tagged `rbac` gets
`security`. For `license_class` they're SPDX identifiers — `apache-2.0` becomes `permissive`.
Adding a topic mapping is now a data edit, not a code change.

The loader rejects a file that has duplicate ids, duplicate aliases within a family, a
`derived` family with no `unknown` value, `min`/`max` on a single-value family, or an `unknown`
value that isn't hidden. If the file is broken, **every process refuses to start** with a message
naming the problem — better than silently classifying into a vocabulary that doesn't exist.

---

## How to do things

### Change a label or description

Edit the YAML. That's it. Descriptions feed the portal, the AI classifier's prompt, and the MCP
tool schemas, so it's worth writing them as "what this means", not "what it's called".

```bash
mise run taxonomy:check   # confirms the file still parses
```

### Add a value to an existing family

1. Add it to `packages/core/taxonomy.yaml` with a label and description.
2. Add a rule that detects it (`packages/analyze/src/rules/`).
3. Add a fixture proving the rule (`packages/analyze/fixtures/`).
4. `mise run ci`.

Step 3 is not optional — see "the pinning test" below. And per `docs/taxonomy.md`, adding a value
is meant to be a deliberate PR: show ten repos that fit nothing existing.

### Add a whole new family

Same as above, plus: a new family means a new filterable attribute in Meilisearch, which means a
**reindex**. That's `mise run rebuild` — build a fresh index from the cache, then swap the alias.
Never change settings on the live index.

### Run it

```bash
mise run taxonomy:check   # validate the YAML on its own
mise run ci               # typecheck + lint + tests + taxonomy:check
mise run dev              # portal on :3000
```

---

## Reading the taxonomy from code

```ts
import { TAXONOMY, family, values, aliasesFor, isValue, facetableFamilies } from '@keco/core';

TAXONOMY                        // all 8 families, in declared order
family('domains').max           // 3
values('openness')              // visible values only (drops `unknown`)
isValue('kind', 'operator')     // true
aliasesFor('domains').get('rbac')  // 'security'
facetableFamilies()             // families that render as chips
```

The whole structure is **deeply frozen**. If you try to mutate it you get a `TypeError` at the
line that did it, rather than silently corrupting the taxonomy for every later caller in that
process. `values()` and `allValues()` hand back a fresh array, so sorting your copy is fine.

---

## Things that will surprise you

**Types are `string` now, not a union.** `Kind` used to be `'cli' | 'operator' | ...`, so a typo
was a compile error. The vocabulary is data now, so it isn't. That was a deliberate trade.

**The replacement is `packages/analyze/src/rules/pinning.test.ts`.** It asserts that every value
a rule can emit actually exists in the YAML. If you add a rule that returns `'wasm-module'` and
the file doesn't declare it, the test fails by name. This is the safety net — treat a failure
there as a real bug, not a test to update.

**`unknown` is an answer, not a bug.** Most repos will report `governance: unknown` until the
CNCF landscape crawler exists, because an organisation account alone proves nothing about who
runs a project. We'd rather say "we don't know" than guess. Same for `openness` — a project is
only called `fully-open` on positive evidence.

**Importing `@keco/core` reads a file.** The YAML is loaded and validated at import time, so any
package importing `@keco/core` does a small synchronous read at startup. It's sub-millisecond.
`@keco/core/events` skips it if you genuinely don't need the taxonomy.

**`install_methods` filters on a nested field.** It's an array of objects, so its Meilisearch
attribute is `install_methods.method`, not `install_methods`. `familyAttribute()` in
`@keco/search` handles that — use it rather than building attribute names by hand.

**The URL parameter isn't always the family id.** `domains` reads `?domain=`, `install_methods`
reads `?install=`. Each family declares its own `param`, and `selectionFromParams()` in
`@keco/query` is the one place that maps them — it works for both Next.js `searchParams` objects
and a raw `URLSearchParams`, so the portal and the REST API can't drift apart.

---

## What isn't done yet

Be aware of this before you go looking for data:

- **The crawler, analyzer and projector are still stubs.** Nothing writes to Meilisearch yet, so
  the index is empty and the home page shows no chips. That's correct behaviour, not a bug — the
  chip rows suppress any value with a zero count.
- **Nothing validates a document before it reaches Meilisearch.** Because types are `string`, a
  typo like `governance: 'vendor_backed'` wouldn't be caught by the compiler, and Meilisearch
  accepts any value. The projector's TODO says to run `ToolDocument.parse()` before upserting —
  **do that when you build it**, or bad values will reach the UI silently.
- **The CNCF landscape seed isn't crawled**, so `maturity` and `governance` fall back to age,
  activity and account type. The rules already handle its absence; they just can't be as precise.

## Known rough edges

Real, tracked, deliberately left alone because fixing them changes how the existing corpus
classifies and each needs its own fixtures:

- The rules call Argo CD a `cli` because it has a `cmd/` directory and uses cobra. It's really an
  in-cluster GitOps controller that happens to ship a client.
- The GitHub topic `helm` maps to the `packaging` domain, but most repos carrying that topic mean
  "you install me with Helm", not "I am a packaging tool".
- `security` and `ci-cd` are missing some common topics (`vulnerability-scanner`, `sbom`,
  `tekton`) that would be easy accuracy wins.
