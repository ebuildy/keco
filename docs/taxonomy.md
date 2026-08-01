# Taxonomy rationale

The vocabulary lives in [`packages/core/src/taxonomy.ts`](../packages/core/src/taxonomy.ts) and is
**closed**. Adding a value is a deliberate PR that adds its rationale here — not an ad-hoc string
at a call site.

## Why two axes

`kind` is what the artifact *is*; `domains` is what problem it solves. Cilium is a `controller`
*and* `networking`; a flat category list cannot express that without either duplicating entries or
losing information. Every consumer (search facets, related tools, alternatives) depends on the two
being separable.

## Health of the vocabulary

A category holding 3 tools, or 4000, is a taxonomy bug, not a fact about the ecosystem. The
backoffice taxonomy screen shows corpus facet counts precisely so this stays visible.

## Adding a value

1. Show the repos that do not fit any existing value — at least ten.
2. Say which existing value they are currently mis-assigned to, and why that hurts a real query.
3. Add the value, add the rule that detects it, add a fixture proving the rule.
4. Re-analyze from cache and diff the classification output.

## Install methods

`install_methods` is not a taxonomy of package managers in the abstract: each entry must carry a
verified command and a `source_url` proving the entry exists in that registry. If it cannot be
proven, it is not listed. Rendering a `brew install` line for a formula that does not exist is the
single worst bug this project can ship.
