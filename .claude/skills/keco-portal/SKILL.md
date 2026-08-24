---
name: keco-portal
description: Use when changing anything under apps/web — the Keco search portal — including its styling, theme, design tokens, Tailwind classes, search page, tool page, facets, keyboard navigation, empty states, or the build-time prerender. Also use when adding a colour, a badge, a chip, or any UI that displays a taxonomy value, a score, or an install command.
---

# Keco portal (`apps/web`)

A static Vite + React SPA with a build-time prerender. No SSR, no server, no framework routing.

**The governing constraint: the prerendered tool page is the SEO surface.** `mise run build`
renders the top ~1000 tool pages to static HTML through `renderToString`. A change that breaks
that is a blocking regression, not a follow-up — and it breaks in ways that pass `tsc`.

**The standing requirement: every change here ships an e2e test, and every spec here names the
e2e tests it will add.** See "Coverage is the requirement" below before writing either.

`CLAUDE.md` is the constitution; its §6, §9, §12 and §14 govern this app. This skill is the map
plus the traps that cost the most, not a restatement of it. Component docblocks are dense and
accurate — read the one above the thing you are changing before deciding it is wrong.

## Where things live

| Need | Place |
|---|---|
| Design tokens, both themes | `src/styles/theme.css` |
| Tailwind entry, `prose-keco`, Shiki dark | `src/styles/index.css` |
| Pure logic (tested, no DOM) | `src/lib/*.ts` — `facets`, `topics`, `spelling`, `keyboard`, `theme`, `site-search`, `dates` |
| Markup only, no branching | `src/components/**` |
| Meilisearch queries | `src/lib/search.ts` — the only place |
| Prerender + its assertions | `prerender/html.ts`, `prerender/ssr.test.ts` |
| End-to-end suites (no backend) | `e2e/*.e2e.ts`, config in `playwright.config.ts` |
| Derived e2e expectations | `e2e/corpus.ts` — computed from the mock corpus, never hardcoded |
| Design rationale | `docs/superpowers/specs/2026-08-24-portal-theme-design.md` |

**Logic goes in `src/lib/` with a test; components hold markup.** `topics.ts` /
`topic-chips.tsx` is the reference pair. A ternary in JSX is fine; a rule is not.

## Traps

**Tokens live in four places.** A new colour needs adding to `:root`, the
`prefers-color-scheme: dark` block, the `[data-theme='dark']` block, *and* `@theme inline`.
Miss the first three and the theme does not follow it. Miss `@theme inline` and `bg-yours`
silently generates **nothing** — no error, no class, just an unstyled element.

**`-soft` tokens already carry alpha in dark.** `--keco-accent-soft` is
`rgb(76 134 240 / 0.16)` there. Opacity modifiers compile to `color-mix`, so `bg-accent-soft/60`
compounds to ≈9.6% and vanishes. Verified in the built CSS. Modifiers on solid tokens are fine.

**Never interpolate a class name.** Tailwind v4 scans source text, so `` `bg-health-${n}` ``
generates nothing. A ternary *choosing between complete literal strings* is fine and used
throughout; only `${}` inside a class name is the trap. For more than two branches use a lookup
of complete strings — `STEPS` in `primitives/meter.tsx`.

**The bootstrap script and the `dark:` variant are a matched pair.** The inline script in
`index.html` stamps `data-theme` *only* for an explicit stored choice, so a system-dark reader
has dark tokens and no attribute. That is why `@custom-variant dark` carries both an attribute
branch and a media branch. Change one without the other and dark mode half-applies: tokens flip,
`dark:` utilities do not.

**Nothing may touch `document` during render.** `renderToString` runs in Node. DOM access
belongs in `useEffect`. `prerender/ssr.test.ts` catches this; it is why `ThemeToggle` starts
light and corrects on hydration.

**`index.html` is under contract.** `prerender/html.ts` fails the build if the built shell loses
its `<title>`, meta description, `</head>`, empty `<div id="root"></div>`, or the
`keco-theme-bootstrap` marker. Editing the shell means checking those still match.

**No `Date.now()` in render.** Use `formatUtcDate`. It exists because a bare `toDateString()`
hydration-mismatches near midnight between the build machine and the reader.

**`ResultCard`'s body is inside a `<Link>`.** Nothing in it may be a link — `Chip`'s `to` prop
would nest anchors and break the roving-tabindex focus model.

## The UI may not overclaim

This is the product's whole thesis, and it is enforced structurally rather than by review.

- **Colour means state, not category.** Accent = *selected*. Green/amber/red = a real state
  (archived, open CVEs, needs review) and always ships an icon **and** a word. Taxonomy families
  are never colour-coded: there are eight, and the palette validator measured violet↔blue at
  ΔE 1.4 under deuteranopia. Distinguish by form and label instead.
- **A score is magnitude, not status.** One hue, more-is-darker, number always beside the bar.
  Painting a repo red because a provider never scanned it is the §4.4 bias made visible.
- **Missing ≠ bad.** A nullable signal renders nothing rather than a zero or a tick.
  `fact-list.tsx` shows "no open CVEs" only when OSV actually answered.
- **Hidden taxonomy values never render.** Go through `values()`, which filters them; §6 hides
  `unknown`, and most real foundation projects report `governance: unknown`.
- **Show labels, not ids.** `kubectl plugin`, not `kubectl-plugin`.
- **An unproven claim is not rendered.** Install commands need a registry `source_url`; "did you
  mean" candidates are verified by a `multiSearch` before display. If you cannot prove it, show
  nothing — silence beats a guess.
- **`indexed_at` is when *the projector* wrote the document.** It says our data may be stale, not
  that the tool changed. Never relabel it as the tool being new or updated.

## Coverage is the requirement

CLAUDE.md §13 and §15 make this a rule, not a preference: **a spec that adds a page, a control
or a state and names no e2e test is incomplete, and a change that adds one without a test is
not done.** Same standard as the analyzer's — a new classification rule requires a fixture
proving it; new portal behaviour requires a test driving it.

It is a rule because of what unit tests here cannot reach. Logic lives in `src/lib/**` precisely
so it is testable without a DOM, and that works — but every bug this app has actually shipped
lived in the seam the unit tests do not cover: focus landing on `<body>` after a URL write,
a facet chip whose accessible name is not what it renders, a suggestion offered that leads
nowhere. `tsc` passes on all of them.

There is no excuse available. `mise run e2e` needs **no backend at all** — Playwright starts
Vite with `VITE_MOCK=1` and MSW answers Meilisearch and `/api/readme/...` inside the page. No
Docker, no Meilisearch, no `apps/api`, no `GITHUB_TOKEN`. The suite runs in ~13s.

**What a change owes:**

| You changed | The test that must exist |
|---|---|
| A route | It renders, and a deep link to it resolves on a hard load |
| A control | Clicking it does the thing *and* writes the URL, since the URL is the state |
| A state (empty, error, zero-result, missing data) | It is reachable in a browser and says something useful |
| A keyboard path | The key is pressed and focus lands where §9 promises |
| A claim (install command, suggestion, count) | It is followed through to what it promises — a suggestion that returns hits, a command copied verbatim |

**Writing one:**

- Derive expectations in `e2e/corpus.ts` from the mock corpus through the same `buildFilters()`
  algebra the page queries with. A hardcoded `299` asserts the fixture file, not the behaviour,
  and breaks when someone adds a curated repo.
- Name files `*.e2e.ts`. The root vitest config globs `*.test.ts`, and a shared suffix is how a
  Playwright file ends up being run by vitest.
- The `page` fixture fails a test on any console error, so a new call in `lib/search.ts` without
  a mock handler surfaces as a failure rather than as an empty page. If the mock does not model
  something the portal now calls, **add the handler** — do not loosen the fixture.
- Assert through roles and accessible names. They are what a reader and a screen reader get, and
  they catch the cases a CSS selector cannot (a pill that carries colour but no word).

**Rationalizations that mean stop:**

| Excuse | Reality |
|---|---|
| "It's a styling change" | Then it is cheap to assert. Colour-carries-meaning bugs are exactly the class e2e catches. |
| "The unit test covers the logic" | It covers the function. It does not cover the function meeting a DOM, a URL and a focus ring. |
| "I'll add the test in a follow-up" | §15 says not done. Follow-ups for tests do not get written. |
| "There's no environment to test against" | There is. `mise run e2e` needs no backend at all. |
| "It's too small to test" | The focus bug in `search.tsx` was four lines. |
| "The prerender/ssr test covers it" | That proves the tree renders in Node. It proves nothing about a browser. |

## Verify

```
mise run ci                  # tsc, eslint (incl. §7 import boundaries), vitest, taxonomy
mise run e2e                 # every route, state and keyboard path, in Chromium, no backend
mise run build               # vite + prerender + assert:no-mocks + api typecheck
mise run web:mock            # ~300 fabricated tools, no crawl needed
```

`mise run build` is the one that catches prerender breakage; `ci` alone will not — and neither
catches a control that renders correctly and does nothing, which is `mise run e2e`'s job. All
three, every time. For anything
visual, run `web:mock` and look — `/search?q=zzzzz` for the empty state, `/tools/<owner>/<repo>`
for the README and score panel. Say plainly whether you actually looked.

`apps/web/src/mocks/**` is dev-and-test only. Never import it from application code.

## Common mistakes

| Symptom | Cause |
|---|---|
| New utility class does nothing | Token missing from `@theme inline` |
| Colour ignores the theme toggle | Token missing from a `[data-theme='dark']` block, or `@theme` used without `inline` |
| Tint invisible in dark | Opacity modifier stacked on an already-translucent `-soft` token |
| `document is not defined` in `mise run build` | DOM read during render instead of in `useEffect` |
| Prerender fails on the shell | `index.html` edit broke one of the five asserted strings |
| README renders flat | `prose-keco` missing on the container |
| Hydration mismatch on a date | `Date.now()` or `toDateString()` instead of `formatUtcDate` |
| Review sends the change back | New behaviour with no `e2e/*.e2e.ts` test driving it (§13, §15) |
| An e2e test breaks when a fixture is added | Expectation hardcoded instead of derived in `e2e/corpus.ts` |
| An e2e test fails on a console error | The portal calls something `src/mocks/handlers.ts` does not model |
