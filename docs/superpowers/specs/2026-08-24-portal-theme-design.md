# Portal theme and the missing read-side UI — design

Date: 2026-08-24
Status: designed

## The governing constraint

**The prerendered tool page is the SEO surface, and the theme must not weaken it.**

§9 makes build-time prerender non-optional and calls a change that makes the top tool pages
non-prerenderable a blocking regression. A design system is exactly the kind of change that can
do it quietly, in three ways, so each is closed explicitly below:

- A stylesheet that only the client loads leaves a crawler reading unstyled markup. The
  prerender reads the **built** `dist/index.html` (`prerender/index.ts`), so Vite's emitted
  `<link rel="stylesheet">` is already inside every prerendered page. This must stay true.
- A theme applied by JavaScript after mount produces a flash of the wrong theme on a page whose
  markup arrived pre-rendered. The fix is a pre-paint inline script, which makes the shell part
  of the prerender contract (`prerender/html.ts` already fails the build when the shell stops
  matching; the theme script joins the things it asserts).
- Tailwind's preflight resets every element to unstyled. The README arrives from `apps/api` as
  sanitised HTML and is injected with `dangerouslySetInnerHTML` — under preflight its headings,
  lists and code blocks lose all styling. `readme_excerpt` in the prerendered page is affected
  the same way. This is the least obvious consequence of adopting Tailwind and is handled in
  "The README under preflight".

Secondary, and equally non-negotiable: nothing here may touch the mock-backend invariant
(`2026-08-23-portal-mock-backend-design.md`), introduce a `VITE_`-prefixed secret, or make the
read side write anything.

## Problem

`apps/web` has no CSS. Not a small amount — none. There is no stylesheet in the repository, no
`<link>` in `index.html`, no import in `main.tsx`. The portal renders as browser-default serif
with blue underlined links.

That is only half the gap. ROADMAP v1 lists the read side as 🚧 with named omissions, and they
are the parts of the pages that carry the product's actual claim:

- **Search** — no facet sidebar, no list/grid toggle, no keyboard navigation, thin empty states.
  `routes/search.tsx` renders a `<ul>` of links and calls itself "the ported baseline, not the
  finished page".
- **Tool page** — no install tabs, no score breakdown UI, no adopters. `routes/tool.tsx` prints
  the three score numbers into a `<dl>` and the install methods into a `<ul>`.

Styling the existing markup without building those would produce a well-dressed page that still
cannot answer "which of these is healthy and how do I install it" — which is the only question
Keco exists to answer. §1: the product is the data quality. The read side's job is to make the
data legible, and a score printed as `0.87` in a definition list does not.

## Scope

**In:**

- A design system — palette, type scale, space scale, radii, elevation — expressed as CSS
  custom properties and consumed through Tailwind v4.
- Light and dark themes, defaulting to the OS preference, overridable by a header toggle that
  persists.
- Self-hosted Inter (variable) plus a monospace face for identifiers and commands.
- An application shell: header with search, theme toggle, footer with corpus freshness.
- Full styling of all four routes: home, search, tool, 404.
- The named ROADMAP v1 components: facet sidebar, active-filter row, list/grid toggle, sort
  control, keyboard navigation, install tabs, score breakdown, related list, empty states.
- `paramsFromSelection` in `@keco/core` — the inverse of the existing `selectionFromParams`, so
  toggling a facet in the URL uses the same vocabulary that reads it.

**Out:**

- `apps/backoffice`. It does not exist (§0) and this design does not create it. Tokens land in
  `apps/web/src/styles/`, not in a shared package; extracting them is a later, cheap move and
  guessing at a second consumer's needs now is not.
- Adopters / "who is using it". §9 requires an `evidence_url` per adopter and the projector does
  not emit adopters yet. The section is not rendered rather than rendered empty.
- Hybrid-search UI, comparison view, momentum board — v2.
- Any change to the write side, the projector, the taxonomy, or the scoring formula.
- Analytics of any kind. §11 rejects `POST /log-search` and nothing here reintroduces it.

## Decisions

### Direction: "Landscape" — light-first, Kubernetes blue, soft-elevation cards

Chosen from three mocked directions (a dark, terminal-dense one; a light editorial one; this
one). Kubernetes blue used deliberately rather than decoratively, 10px radii, cards with a
1px border and a barely-there shadow, chips for taxonomy values.

Light is the default because the tool page carries long-form README prose and is the page
arriving from organic search. Dark-only would mean every crawler-sourced visitor lands on a
dark page in daylight, and adding light to a dark-first system is harder than the reverse.

### Dark mode: `data-theme` attribute, OS default, toggle overrides, set before paint

```
system preference ──(no stored choice)──▶ data-theme unset, @media decides
stored choice ─────────────────────────▶ data-theme="light" | "dark" wins
```

An inline `<script>` in `index.html`'s `<head>` reads `localStorage.keco-theme` and stamps
`document.documentElement.dataset.theme` **only when an explicit choice is stored**. It is inline
and blocking on purpose: a deferred module would run after first paint and flash the wrong theme,
and on a prerendered page there is real content to flash.

It deliberately does *not* call `matchMedia` and does *not* stamp a resolved value. With no stored
choice the attribute stays absent and the `prefers-color-scheme` block decides, which keeps the
attribute meaning exactly one thing: "a human overrode the OS". The cost of that purity is that
`dark:` utilities cannot key off the attribute alone — a system-dark reader who never touched the
toggle has dark tokens and no attribute — so `@custom-variant dark` **must** carry a media-query
branch as well as an attribute branch. The two are a matched pair: change either one and the
other has to change with it, or dark mode half-applies. See "The `dark:` variant" below.

Rejected: system-preference-only. It costs nothing and cannot flash, but a reader cannot choose,
and the user asked for a dark theme as something they can have — not as something their laptop
grants them.

Rejected: a cookie plus server-side rendering of the attribute. There is no server rendering;
the prerender is a build step and cannot know a reader's preference.

**This makes the shell a contract.** `prerender/html.ts` already throws when the built shell no
longer contains a `<title>`, a `<meta name="description">`, a `</head>` or an empty
`<div id="root">`, on the principle that a silent miss is a shipped regression. The theme script
is added to that list: if it disappears from `index.html`, the build fails rather than shipping
1000 static pages that flash white.

### Tailwind v4, CSS-first, with tokens as real custom properties

Tailwind is a build-time `devDependency`. §7's import boundaries govern runtime imports in
`.ts`/`.tsx` and are a denylist; Tailwind is neither imported at runtime nor on that list, so no
boundary is crossed and no ADR is owed. §1's "no heavy infrastructure" names Redis, queues,
Turborepo and SSR frameworks — build tooling that emits a stylesheet is a different category.

The mechanism matters more than the choice. Tailwind v4 is configured in CSS, not in a
JavaScript config file, and the theme toggle needs tokens that can be *redefined at runtime* —
which `@theme` alone cannot do, because it emits static values. The pattern is two layers:

```css
/* layer 1 — semantic values, redefinable per theme */
:root                { --keco-surface: #ffffff; --keco-text: #111827; /* … */ }
[data-theme='dark']  { --keco-surface: #151d2e; --keco-text: #f1f4fa; /* … */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) { /* the same dark block */ }
}

/* layer 2 — Tailwind reads them by reference, so utilities follow the theme */
@theme inline {
  --color-surface: var(--keco-surface);
  --color-fg:      var(--keco-text);
}

@custom-variant dark {
  &:where([data-theme='dark'], [data-theme='dark'] *) { @slot }
  @media (prefers-color-scheme: dark) {
    &:where(:root:not([data-theme='light']), :root:not([data-theme='light']) *) { @slot }
  }
}
```

`@theme inline` is what makes `bg-surface` resolve against the element rather than taking an extra
hop through a `:root` indirection. (Without `inline`, Tailwind still emits
`--color-surface: var(--keco-surface)` and the toggle still works — the gain is one less
indirection and correct resolution for nested overrides, not the difference between working and
broken.)

### The `dark:` variant

The variant is written in block form with **two** branches because the token layers have two
triggers, and it has to mirror them exactly. The attribute branch serves readers who used the
toggle; the media branch serves readers who never did and whose attribute is therefore absent.

Deleting either branch produces the same silent, half-broken result: tokens flip but `dark:`
utilities do not, so anything expressed as a `dark:` utility rather than as a token — most
importantly `dark:prose-invert` on the README — renders in the wrong theme for that population.
Nothing type-checks or lints this; the only guard is that the pairing is written down here.

Consequence, and a rule: **no dynamically constructed class names.** Tailwind v4 finds classes
by scanning source text, so `` `bg-${tone}` `` produces a class that is never generated. Where a
value maps to a style — a health band, a status pill — the map holds complete class strings.

### Self-hosted Inter variable, and a monospace face for identifiers

`@fontsource-variable/inter` (5.3.0), imported from the stylesheet so Vite fingerprints the
woff2 into `dist/assets` and `apps/api` serves it. No third-party request on the LCP path of
pages whose whole job is organic search, nothing to allow in a future CSP, no privacy question.

Monospace is the system stack (`ui-monospace, SFMono-Regular, Menlo, …`) rather than a second
downloaded face. It carries `owner/repo`, install commands, counts and scores — identifiers and
figures, where the tabular alignment matters more than the specific face, and where every
platform's default is already good.

### Colour means state, not category

The first mockup colour-coded facet chips by taxonomy family — blue `kind`, violet `domains`,
green `install_methods`. The palette validator rejects it:

```
[FAIL] CVD separation      #5B45C7 ↔ #2456BE  ΔE 1.4 (deutan) · 3.3 (tritan)
[FAIL] Normal-vision floor #5B45C7 ↔ #2456BE  ΔE 7.3, against a floor of 15
```

Violet and blue are indistinguishable to a deuteranopic reader and marginal for everyone else.
The deeper problem is arithmetic: there are **eight** facetable families, past the ~7 ceiling
where categorical colour works at all, and a ninth would have no hue left to take.

So chips are neutral and name their family in the label — `kind: controller` — and the accent
blue is reserved for one job: **selected**. Colour now encodes interaction state, which has two
values and always will, instead of category, which has as many values as the taxonomy grows.

### Health is magnitude, so it is one hue; status colours are reserved

`score.total` and the four axes are a 0–1 magnitude, not four identities. They render as
same-hue meters, more-is-darker, with the number always beside the bar — never colour alone.

Green / amber / red is reserved for genuine **state**: `archived`, `osv.open_vulns > 0`,
`needs_review`. Each ships as a pill with an icon *and* a word.

This is not only a dataviz convention; it is what §4.3 and §4.4 require. "Missing ≠ bad" and
"absence of evidence never becomes a positive claim" are incompatible with painting a repo red
because OpenSSF's cron set never scanned it. A low-coverage repo gets a short bar and a
coverage caption, not a verdict.

`quality_coverage` renders as a dashed ceiling on the Quality meter — the share of that axis
that could be scored at all — with the sentence §4.4 demands: *"Quality scored on 4 of 5
signals."* A 0.9 from four signals and a 0.9 from one must not look identical, and here they
do not.

### The facet sidebar costs no new query

`searchTools()` in `apps/web/src/lib/search.ts` already passes `facets: defaultFacets()` and
already returns `facets` in `PortalSearchResult`. `routes/search.tsx` simply ignores it. The
sidebar is rendered from data the page has been fetching all along — no second request, no
change to the search client, no `useEffect`.

A family with no hits renders no group, and a value with no hits renders no row — the same rule
`chipRows` already applies on the home page, for the same reason: before the first crawl the
index is empty, and a wall of zero-count checkboxes is worse than nothing.

### No component library

A handful of small components over markup that is already semantic and accessible. Radix or
similar would add a runtime dependency to a browser bundle §7 keeps deliberately thin, to
replace `<details>`, a `<fieldset>` of checkboxes and a tab strip. The one genuinely fiddly
piece is roving-tabindex keyboard navigation, specified below.

## Design tokens

Light / dark pairs. `--keco-text-2`, `--keco-text-muted` and `--keco-text-faint` are re-spaced
per theme, not shared: a contrast pass (§ code review, 2026-08-24) found the original ramps as
low as 2.34:1 against `--keco-bg` in light, and darkening `--keco-text-faint` alone without
respacing the other two would have inverted the hierarchy. Both ramps now clear 4.5:1 against
`bg` / `surface` / `surface-2`, worst case, in both themes.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--keco-bg` | `#F5F7FB` | `#0E1421` | page ground |
| `--keco-surface` | `#FFFFFF` | `#151D2E` | cards, header, sidebar |
| `--keco-surface-2` | `#F1F5FA` | `#1B2437` | chips, meter tracks, code ground |
| `--keco-border` | `#E7EDF6` | `#212B40` | hairlines |
| `--keco-border-strong` | `#7D8DA9` | `#63769C` | inputs, controls — 3:1 UI-boundary contrast |
| `--keco-text` | `#111827` | `#F1F4FA` | headings, body |
| `--keco-text-2` | `#41506A` | `#AEB9CC` | prose, summaries |
| `--keco-text-muted` | `#4E5D75` | `#98A5BB` | metadata, captions |
| `--keco-text-faint` | `#5B6878` | `#8494AD` | counts, timestamps |
| `--keco-accent` | `#326CE5` | `#4C86F0` | filled buttons, brand mark, selected |
| `--keco-accent-text` | `#1E4FBB` | `#7BA9FF` | links, tool names |
| `--keco-accent-soft` | `#EAF1FE` | `rgba(76,134,240,.16)` | selected chip ground |
| `--keco-good` | `#127048` | `#5FD8A0` | status: verified, no CVEs |
| `--keco-warn` | `#8A5A0B` | `#E3B341` | status: archived, needs review |
| `--keco-bad` | `#B42318` | `#FF8A7A` | status: open vulnerabilities |
| `--keco-focus` | `rgba(50,108,229,.35)` | `rgba(76,134,240,.45)` | focus ring |

Health fill is a **sequential ramp of the accent hue — one hue, more-is-darker**, stepped by the
score so a weak repo reads as a short pale bar and a strong one as a long saturated bar. Four
steps, not a continuous interpolation, so the same score always paints the same colour:

| Score | Light | Dark |
|---|---|---|
| `< 0.40` | `#A9BEE4` | `#31456B` |
| `0.40 – 0.64` | `#749CD9` | `#3E6099` |
| `0.65 – 0.84` | `#3E6FD1` | `#4C86F0` |
| `≥ 0.85` | `#1E4FBB` | `#7BA9FF` |

Tracks are `--keco-surface-2`. Bars are 6px, radius 3px, data-end rounded and baseline square.
The number sits beside every bar, so the ramp is reinforcement and never the only encoding —
which is what lets the same component stay readable under any colour-vision deficiency.

Scale: type `12 / 13 / 14 / 16 / 20 / 25 / 32`; space on a 4px grid; radii `5 / 6 / 10`;
elevation is one shadow (`0 1px 3px rgba(16,24,40,.05)`) in light and Tailwind's no-shadow
sentinel (`0 0 #0000`) in dark, where the surface step carries the elevation instead — plain
`none` collapses the whole composed `box-shadow` declaration Tailwind builds from `--tw-shadow`,
taking any `ring-*` on the same element down with it.

## Architecture

```
apps/web/src/
├── styles/
│   ├── theme.css            # :root + [data-theme] tokens, @theme inline, @custom-variant
│   └── index.css            # @import tailwindcss, fontsource, theme.css, prose overrides
├── components/
│   ├── shell/               # app-shell, header, search-field, theme-toggle, footer
│   ├── search/              # facet-sidebar, facet-group, active-filters, view-toggle,
│   │                        #   sort-select, result-card, result-grid-card, empty-state
│   ├── tool/                # install-tabs, score-meters, fact-list, related-list
│   ├── primitives/          # chip, pill, status-pill, meter, copy-button, kbd
│   └── topic-chips.tsx      # exists; restyled, logic untouched
└── lib/
    ├── facets.ts            # pure: distribution + selection → sidebar groups; toggle helpers
    ├── theme.ts             # read/write the stored preference; the toggle's only state
    └── keyboard.ts          # pure: roving-focus index reducer
```

Logic stays out of `.tsx`, matching `topics.ts` / `topic-chips.tsx`: `facets.ts` and
`keyboard.ts` are pure and unit-tested without a DOM, and the components that consume them hold
no branching worth testing.

`index.html` gains one inline `<script>` (theme bootstrap). **No font preload**, despite the
earlier draft of this document promising one: `@fontsource-variable/inter` is imported from CSS,
so Vite fingerprints the woff2 and the filename is not knowable when `index.html` is authored.
Injecting a correct `<link rel="preload">` would mean post-processing the built shell. The
stylesheet that references the font is render-blocking anyway, so the request starts the moment
it parses — a preload saves one round trip and costs a build step, which is the wrong trade at
this size. Revisit if the font ever shows up as an LCP problem in the field.

`index.html` also gains, from Vite, the
Inter woff2. `main.tsx` gains one CSS import. `vite.config.ts` gains `@tailwindcss/vite`.

## Components

Each is listed as *what it does · what it takes · where its data comes from*.

**`AppShell`** — header, `<main>`, footer; owns the max width (1200px) and the page grid. Header
holds the brand mark, a compact search field on every route except home, and `ThemeToggle`.
Footer carries corpus size and `indexed_at`, because §2.7 makes freshness the contract and the
UI shows it rather than pretending the data is live.

**`ThemeToggle`** — a `<button aria-pressed>` cycling light ⇄ dark; writes `localStorage` and the
root `data-theme`. Reads its initial value from the attribute the inline script already set, so
it never disagrees with what is on screen.

**`FacetSidebar` / `FacetGroup`** — one group per facetable family with hits, from
`PortalSearchResult.facets` and `selectionFromParams`. Checkboxes in a `<fieldset>` with a
`<legend>`; count right-aligned in tabular figures. Groups past five values collapse behind
"Show N more" (`<details>`, so it works without JS and is keyboard-native). Toggling writes the
URL through `paramsFromSelection` — the URL remains the only state store on the page, which is
`search.tsx`'s existing and deliberate design.

**`ActiveFilters`** — the current selection as removable chips above the results, plus "Clear
all". Each chip names its family (`kind: controller`) per the colour decision.

**`ViewToggle` / `SortSelect`** — write `?view=list|grid` and `?sort=`, both already in §9's URL
contract. `view` defaults to `list`; `isSortKey` already narrows `sort`.

**`ResultCard`** (list) / **`ResultGridCard`** (grid) — name, owner, summary, taxonomy chips,
health meter + number, and a metadata line (`★ stars · language · licence · pushed`). A
`StatusPill` appears only when there is a state to report.

**`InstallTabs`** — one tab per verified method, `role="tablist"` with arrow-key movement, the
command in a mono block with `CopyButton`, and beneath it the proof line: registry name, the
`source_url` link, and `verified_at`. When `install_methods` is empty the block renders §6's
honest sentence rather than a guess — unprovable means not listed, and a fabricated
`brew install` line is the worst bug this project can ship.

**`ScoreMeters`** — the hero total, the coverage sentence, and four labelled meters carrying
their weights (35 / 30 / 20 / 15, matching §4.4). The Quality meter carries the dashed
`quality_coverage` ceiling. Renders as an accessible `<dl>` with `role="img"` and an `aria-label`
per meter, so a screen reader gets the number without decoding a bar.

**`FactList`** — stars, forks, language, licence, last commit, latest release, open CVEs. UTC
dates through the existing `formatUtcDate`, which exists because a bare `toDateString()`
hydration-mismatches near midnight between the build machine and the reader.

**`RelatedList`** — `findAlternatives()` output, name + owner + score. Unchanged logic.

**`EmptyState`** — three cases, each suggesting a next step: no query yet, zero results (offers
broader facets, mirroring the existing copy), and search unavailable (keeps
`searchErrorMessage`'s distinction between a missing `VITE_MEILI_SEARCH_KEY` and a genuine
outage — the two are different problems and one of them a reader cannot act on).

## Keyboard navigation

§9 requires it; ROADMAP names it as missing. The contract:

| Key | Effect |
|---|---|
| `/` | focus the search field — **ignored while focus is in an input, textarea or contenteditable** |
| `↓` / `↑` | move focus between results; from the search field, `↓` enters the list |
| `Enter` | open the focused result |
| `Escape` | from a result, return focus to the search field; from the search field, clear the query |
| `Tab` | normal document order — the result list is one tab stop (roving `tabindex`) |

Roving tabindex, not `aria-activedescendant`: results are links, and a focused link gets Enter,
middle-click and "open in new tab" from the browser rather than from re-implemented handlers.
`keyboard.ts` holds the index reducer as a pure function; the component binds it.

## The README under preflight

Tailwind's preflight strips default element styling. The README is sanitised HTML from
`apps/api` injected with `dangerouslySetInnerHTML` — headings, lists, tables and blockquotes
would all render flat, and so would `readme_excerpt` on the prerendered page.

`@tailwindcss/typography` supplies `prose`, applied to the README container with
`prose-invert` under dark. Its colour tokens are overridden to the `--keco-*` palette in
`index.css` so the README does not carry a second, unrelated set of greys.

Shiki highlighting arrives with its own inline colours from `apps/api`. `prose` must not fight
it: `pre`/`code` are reset to `--keco-surface-2` with typography's own `code` colour and
backtick pseudo-elements disabled, letting Shiki's spans win.

This is the one place where adopting Tailwind actively degrades an existing surface, which is
why it is called out here rather than left to be discovered.

## Preserving the invariants

- **Prerender.** `prerender/html.ts` gains a fifth assertion: the built shell must contain the
  theme bootstrap script, identified by a stable marker. A test renders a fixture shell through
  `toolPageHtml` and asserts the script survives into the output, next to the existing shell
  assertions.
- **The mock backend.** Untouched. `assert-no-mocks` still runs in `mise run build`; no component
  imports from `src/mocks/`; MSW stays a `devDependency`. Tailwind scanning `src/**` for class
  names does not change what Rollup emits, and `import.meta.env.DEV` still eliminates the branch.
- **Secrets.** No new environment variable of any kind, and specifically none with a `VITE_`
  prefix — §12: that prefix is a published secret, permanently, in every deployed artifact.
- **CQRS.** Every component is a pure function of `ToolDocument` and URL state. Nothing here
  writes anything, and the only network calls are the ones that already exist.
- **Taxonomy is data.** No component enumerates a family's values. The sidebar loops
  `facetableFamilies()`, exactly as the home page's chip rows already do, so a ninth family
  needs no edit here (§6).

## Testing

Following §13 and the repo's existing pattern — logic is pure and tested, components are not
snapshot-tested.

- `lib/facets.test.ts` — distribution + selection → groups: zero-count values dropped, empty
  families dropped, ordering, collapse threshold, toggle add/remove round-trips through
  `selectionFromParams` ∘ `paramsFromSelection`.
- `lib/keyboard.test.ts` — the index reducer: bounds, wrap behaviour, and that `/` is inert when
  the event target is an input.
- `lib/theme.test.ts` — stored preference wins over `matchMedia`; absent preference falls
  through; an unrecognised stored value is ignored rather than stamped.
- `packages/core/src/read.test.ts` — `paramsFromSelection` is the inverse of
  `selectionFromParams` for every facetable family, including multi-value families.
- `prerender/html.test.ts` — the theme-script assertion fires when the marker is absent, and the
  script survives a real prerender.
- `scripts/assert-no-mocks.test.ts` — unchanged, still green.
- Palette: `--keco-good/warn/bad` re-validated against both surfaces before the tokens land, and
  every text/ground pair checked to ≥ 4.5:1 (≥ 3:1 for large text and UI edges).

Manual, per §15.5: the tool page still prerenders with a real `<h1>`, metadata and JSON-LD;
search is keyboard-navigable end to end; no `VITE_`-prefixed secret entered the bundle; and
`kubernetes/kubectl` renders with its relative images intact, which is §14's named README trap.

## Error and empty states

The index is empty until the first crawl, and that is a true state of the system rather than a
failure. Every surface has a defined appearance for it: Browse renders nothing (already true),
search renders the "no results yet" empty state, the momentum section is omitted, and the footer
reports zero indexed documents rather than a blank.

`searchErrorMessage`'s two-way distinction is preserved verbatim and rendered as an alert card,
not a bare `<p role="alert">`.

## Documentation

- `apps/web/README.md` gains a short section: where tokens live, how the theme attribute works,
  and the no-dynamic-class-names rule.
- ROADMAP v1 read-side entries move from 🚧 to ✅ for the items delivered, with the ones left
  out (adopters, hybrid search) still listed.
- AGENTS.md §9 gains one paragraph naming the theme mechanism and the shell assertion, because
  the shell is now a contract and §15.7 requires the file to record a contract change.
- No ADR. Nothing here reverses a recorded decision: Tailwind is build tooling rather than the
  infrastructure §1 rejects, and no §7 boundary moves.

## Definition of done

`mise run ci` green; §15.5 satisfied; §15.6 satisfied (nothing on the read side writes a read
model); the prerendered top tool pages carry `<h1>`, metadata, JSON-LD and the theme script;
`mise run build` completes including `assert:no-mocks`.
