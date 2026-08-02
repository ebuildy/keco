# Taxonomy rationale

The vocabulary lives in [`packages/core/taxonomy.yaml`](../packages/core/taxonomy.yaml) and is
**closed**. Adding a value is a deliberate PR that adds its rationale here — not an ad-hoc string
at a call site, and not a value with no rule behind it.

## The eight families

| Family | Cardinality | Assigned by |
|---|---|---|
| `kind` | exactly one | analyzer rules, LLM fallback |
| `domains` | one to three | analyzer rules, LLM fallback |
| `runtime` | exactly one | analyzer rules |
| `install_methods` | any number | registry proof only |
| `license_class` | exactly one | derived from the SPDX id |
| `openness` | exactly one | derived from licence and repository markers |
| `maturity` | exactly one | derived from the CNCF landscape, age and activity |
| `governance` | exactly one | derived from the CNCF landscape and the account type |

## Why more than one axis

`kind` is what the artifact *is*; `domains` is what problem it solves; `runtime` is where it
executes. cert-manager is an `operator`, solving `security`, running `in-cluster`; kubectx is a
`kubectl-plugin` running on your `workstation`. A flat category list cannot express that without
either duplicating entries or losing information. Every consumer — search facets, related tools,
alternatives — depends on the axes being separable.

`runtime` deliberately does not overlap `install_methods`. "How do I get it" is a proven registry
fact with a command and a URL behind it; "where does it run" is a classification. No value
appears in both.

## Unknown is a real answer

Every family whose classification can fail declares `unknown`, and `unknown` is the default for
`runtime`, `license_class`, `openness`, `maturity` and `governance`. A missing licence does not
make a project closed; a repository absent from the CNCF landscape is not therefore
vendor-owned. This is the same rule §4.2 applies to a missing Scorecard: absence renormalises, it
never scores as zero. `unknown` values are `hidden: true` and never render as a chip.

`openness` is the family most likely to make a wrong public claim about someone's project. It is
promoted to `fully-open` only on positive evidence — an open licence *and* no enterprise
markers in the tree or the README. If it proves noisy against real data, tighten the rule. Do
not backfill guesses.

Two consequences of "evidence only, never guessed" are worth calling out because they read as
surprising until you look at the rule:

- **`governance` will report `unknown` for most real foundation projects** — etcd-io,
  containerd, helm, prometheus, cilium — until the CNCF landscape crawler ships and caches a
  seed. An organisation account alone proves nothing about who steers a project; HashiCorp's
  orgs have hundreds of contributors and are vendor-governed, so the rule requires landscape
  evidence (or membership in the small set of upstream Kubernetes orgs) before it will say
  `foundation`, `vendor-backed` or `community`. That is expected and honest, not a bug to chase.
- **`maturity` checks `archived` before the CNCF level.** `LandscapeEntry.cncf_level` has no
  retired state, and nothing keeps a cached landscape seed in lockstep with CNCF's own
  retirement bookkeeping — a project can be archived on GitHub today while a stale seed still
  records it as `cncf-incubating`. `archived` is the freshest and strongest signal available (it
  comes straight from GitHub on every crawl), so an archived CNCF-graduated project reports
  `archived`, not `cncf-graduated`. Filtering the Maturity facet for "still alive" has to mean
  something.

## Health of the vocabulary

A category holding 3 tools, or 4000, is a taxonomy bug, not a fact about the ecosystem. The
backoffice taxonomy screen shows corpus facet counts precisely so this stays visible.

## Adding a value

1. Show the repos that do not fit any existing value — at least ten.
2. Say which existing value they are currently mis-assigned to, and why that hurts a real query.
3. Add the value to `taxonomy.yaml` with a label and a description that says what it means, not
   what it is called.
4. Add the rule that detects it, and a fixture in `packages/analyze/fixtures` proving the rule.
5. Run `mise run ci`. The pinning test in `packages/analyze/src/rules/pinning.test.ts` fails if a
   rule emits a value the file does not declare, and — for the derived families — if the file
   declares a value no rule can produce.
6. Re-analyze from cache and diff the classification output.

## Adding a family

A new family also needs a new `filterableAttribute`, which is a settings change, which means a
rebuild and an alias swap — never a mutation of the live index (§5). Everything else is derived:
`packages/search`, `packages/query` and the home page all loop over the file.

## Install methods

`install_methods` is not a taxonomy of package managers in the abstract: each entry must carry a
verified command and a `source_url` proving the entry exists in that registry. If it cannot be
proven, it is not listed. Rendering a `brew install` line for a formula that does not exist is the
single worst bug this project can ship.
