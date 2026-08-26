# `infra/mock` — a seeded Meilisearch for exercising the search engine

`corpus.json` is 300 fabricated `tools` documents. Two tasks put them into a local Meilisearch
so the read model can be searched for real — facets, ranking rules, sorts, deep paging — before
the projector exists to fill it from a crawl.

```sh
mise run infra:up     # Meilisearch on :7700
mise run mock         # engine index create + engine seed --clear
mise run web          # the portal, now searching a real engine
```

Individually:

| Task | What it does |
|---|---|
| `mise run mock:corpus` | Re-emits `corpus.json` from `apps/web/src/mocks/corpus` |
| `mise run engine:index` | `engine index create` — creates the target index and applies the real `tools` settings |
| `mise run engine:seed` | `engine seed` — validates `corpus.json` and upserts it in batches |

Both are subcommands of the `engine` CLI (`apps/workers/src/engine`, commander), so
`mise run engine -- --help` and `mise run engine -- seed --help` list every flag. Both take
`--host <url>` and `--index <uid>` (default `tools`); `seed` also takes `--batch <n>`,
`--clear` and `--force`.

`engine index create` is the one command here that is **not** mock-specific — it is how a fresh
deployment's index is bootstrapped, production included. It applies settings only to an index
that is missing or empty, and refuses to reindex a populated one without `--force-settings`,
because a settings change on a live alias reindexes the whole corpus (AGENTS.md §5).

## Why a JSON file

The corpus is declared once, in TypeScript, under `apps/web/src/mocks/corpus`: `curated.ts` is
hand-written from real projects, `generate.ts` is a seeded generator, and `builder.ts` keeps
every document schema-valid. That is the source of truth, and it stays there — the portal's MSW
backend serves it directly.

The write side cannot import it. `apps/workers` may not reach into a browser bundle's fixtures,
and `apps/web` may not import `@keco/search` (AGENTS.md §7), so a file on disk is the only seam
the two share. `apps/web/scripts/emit-mock-corpus.ts` writes it; the output is deterministic
(seeded generator, no timestamps), so the artifact is committed and
`emit-mock-corpus.test.ts` fails `mise run ci` the moment it drifts from the generator.

One compact document per line rather than an indented tree: still a plain JSON array that
`JSON.parse` reads whole, but a fixture change shows up as one changed line per changed
document instead of a 600 KB rewrite.

## This is fabricated data, and it must stay local

The documents carry invented stars, scores and — this is the one that matters — invented
`install_methods`. §6 calls a `brew install` line for a formula that does not exist the worst
bug this project can ship. Three things keep this corpus where it belongs:

- **Every document carries the mock sentinel** (`KECO_MOCK_CORPUS_DO_NOT_SHIP`) in
  `discovery_source`. The seeder refuses a corpus where any document does not, so it cannot be
  repurposed to push real documents, and any seeded index can be identified by filtering on it.
- **Every document is parsed through `ToolDocument`** before it is sent. The taxonomy is data,
  so a bad `governance` value is not a type error — validation is what catches it.
- **The seeder refuses a non-local `MEILI_HOST`** unless you type `--force`.

The projector is the only writer to the real corpus (AGENTS.md §4.4). This task writes documents
no crawl produced, consumes no journal and advances no checkpoint; when the projector lands,
neither one learns about the other. Wiping this is `mise run infra:reset`.
