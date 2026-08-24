# Portal Theme and Read-Side UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/web` a complete light/dark design system and build the ROADMAP v1 read-side components it is missing — facet sidebar, list/grid toggle, keyboard navigation, install tabs and score breakdown.

**Architecture:** Tailwind v4 configured in CSS, reading semantic tokens through `@theme inline` so a `data-theme` attribute can swap them at runtime. A pre-paint inline script in `index.html` stamps that attribute, which makes the shell part of the prerender contract. All page logic stays in pure, unit-tested modules under `src/lib/`; components hold markup only, matching the existing `topics.ts` / `topic-chips.tsx` split.

**Tech Stack:** Vite 8, React 19, react-router 8, Tailwind CSS 4.3.3, `@tailwindcss/vite`, `@tailwindcss/typography`, `@fontsource-variable/inter`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-portal-theme-design.md`

**Branch:** `feat/portal-theme` (already created; the spec is committed on it).

---

## Background you need before Task 1

Read these or you will make avoidable mistakes:

- **`AGENTS.md` §9** — the portal is a static SPA with build-time prerender. §7 — `apps/web/src` is a browser bundle and may import `@keco/core` and `meilisearch` only. §14 — `VITE_`-prefixed variables are public forever.
- **`apps/web/src/lib/search.ts`** — the portal's only Meilisearch client. `searchTools()` already requests `facets: defaultFacets()` and already returns them in `PortalSearchResult.facets`. `routes/search.tsx` ignores that field today. **The facet sidebar needs no new query.**
- **`packages/core/src/read.ts`** — `selectionFromParams`, `buildFilters`, `familyAttribute`, `sortSpec`, `isSortKey`. Note `familyAttribute('install_methods')` returns `'install_methods.method'`, so that is the key in the facet distribution. Every other family's key is its own id.
- **`apps/web/src/lib/topics.ts`** — the pattern to copy for `facets.ts`: pure function, distribution in, view model out, zero-count values dropped.
- **The mock backend.** `mise run web:mock` serves ~300 fabricated tools so you can see every screen without a crawl. Use it for every visual verification step. Never import from `src/mocks/` in application code — lint will fail you, and §14 explains why.

**Run tests with:** `pnpm vitest run <path>` from the repo root. **Run everything with:** `mise run ci`.

---

## File structure

**Created:**

| File | Responsibility |
|---|---|
| `apps/web/src/styles/theme.css` | Semantic tokens for both themes; `@theme inline`; the `dark` variant |
| `apps/web/src/styles/index.css` | Tailwind + font + prose overrides; the one stylesheet `main.tsx` imports |
| `apps/web/src/lib/theme.ts` | Read/write the stored theme preference. Pure except for two guarded browser calls |
| `apps/web/src/lib/facets.ts` | Distribution + selection → sidebar groups. Pure |
| `apps/web/src/lib/keyboard.ts` | Roving-focus reducer and the `/` shortcut guard. Pure |
| `apps/web/src/components/primitives/*` | `chip`, `status-pill`, `meter`, `copy-button`, `kbd` |
| `apps/web/src/components/shell/*` | `app-shell`, `site-header`, `site-footer`, `search-field`, `theme-toggle` |
| `apps/web/src/components/search/*` | `facet-sidebar`, `active-filters`, `result-card`, `search-controls`, `empty-state` |
| `apps/web/src/components/tool/*` | `install-tabs`, `score-meters`, `fact-list`, `related-list` |

**Modified:**

| File | Change |
|---|---|
| `apps/web/index.html` | Theme bootstrap script (no font preload — see spec) |
| `apps/web/vite.config.ts` | `@tailwindcss/vite` plugin |
| `apps/web/src/main.tsx` | Import the stylesheet |
| `apps/web/src/app.tsx` | Wrap routes in `AppShell` |
| `apps/web/prerender/html.ts` | Fifth shell assertion: the theme script |
| `apps/web/prerender/html.test.ts` | Fixture shell gains the marker (**do this first or every test in the file throws**) |
| `apps/web/src/lib/search.ts` | `browseFacets` returns `{ facets, total }` |
| `packages/core/src/read.ts` | `paramsFromSelection`, `toggleFacetValue` |
| `apps/web/src/routes/*.tsx` | Styled; new components wired in |

---

## Task 1: Install and wire the toolchain

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`

- [ ] **Step 1: Install the packages**

```bash
pnpm -F @keco/web add @fontsource-variable/inter
pnpm -F @keco/web add -D tailwindcss @tailwindcss/vite @tailwindcss/typography
```

Inter is a runtime `dependency` because `src/styles/index.css` imports it and the woff2 ships in `dist/`. Tailwind is build tooling and stays a `devDependency` — this is what keeps §7's "browser bundle" claim true and is why no ADR is owed.

- [ ] **Step 2: Add the Vite plugin**

Replace the top of `apps/web/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
```

and change the `plugins` line to:

```ts
  plugins: [react(), tailwindcss()],
```

Leave the doc comment, `server`, and `build` blocks exactly as they are.

- [ ] **Step 3: Verify the workspace still typechecks**

Run: `mise run check`
Expected: PASS. Nothing imports Tailwind yet, so this only proves the install did not break resolution.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/vite.config.ts pnpm-lock.yaml
git commit -m "build(web): add tailwind v4, typography plugin and self-hosted Inter"
```

---

## Task 2: Design tokens

> **Superseded in part — read this before using the code blocks below.** Tasks 1 and 2 are
> implemented, and a code review then found real defects in the CSS printed here. Commit
> `9674667` (`fix(web): correct token contrast, Shiki dark mode and five silent no-ops`) is the
> current truth. The blocks below are kept for the rationale; take the *values* from the
> committed files. What changed:
>
> - Both neutral ramps were re-spaced — the light `--keco-text-faint` measured 2.34:1 against
>   `--keco-surface-2` and carried body text. All four levels now clear 4.5:1 in both themes.
> - `--keco-border-strong` darkened to `#7d8da9` / `#63769c` to clear WCAG 1.4.11's 3:1 for a
>   control boundary. `--keco-border` stayed soft — hairlines are decorative and exempt.
> - `--keco-shadow-card: none` became `0 0 #0000`. `none` is invalid as a member of Tailwind's
>   composed `box-shadow` list and silently dropped every `ring-*` on the same element in dark.
> - `--color-health-1..4` and `--color-focus` were added to `@theme inline`. Without them
>   `bg-health-2` generates nothing — so **later tasks may use `bg-health-*` directly** rather
>   than the `bg-[var(--keco-health-*)]` arbitrary-value form printed in Task 8.
> - `@custom-variant dark` gained a media-query branch. See the spec's "The `dark:` variant".
> - `index.css` gained rules activating Shiki's `--shiki-dark` variables, without which every
>   README code block rendered as a white slab in dark mode.

**Files:**
- Create: `apps/web/src/styles/theme.css`
- Create: `apps/web/src/styles/index.css`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Write `apps/web/src/styles/theme.css`**

```css
/*
 * Design tokens (docs/superpowers/specs/2026-08-24-portal-theme-design.md).
 *
 * Two layers, and the split is load-bearing. Layer one is the semantic values, defined as
 * ordinary custom properties so they can be *redefined at runtime* when the theme changes.
 * Layer two is `@theme inline`, which tells Tailwind to emit utilities that reference those
 * variables rather than baking a hex at build time. Without `inline`, `bg-surface` would
 * freeze the light value and the toggle would change nothing.
 *
 * The dark block is written twice on purpose: once under the media query for readers who
 * never touched the toggle, once on the attribute for readers who did. CSS has no way to say
 * "this selector OR that media query" in one rule, and an indirection that avoided the
 * duplication would cost more clarity than the twelve repeated lines it saved.
 */

:root {
  color-scheme: light;

  --keco-bg: #f5f7fb;
  --keco-surface: #ffffff;
  --keco-surface-2: #f1f5fa;
  --keco-border: #e7edf6;
  --keco-border-strong: #dde5f2;

  --keco-text: #111827;
  --keco-text-2: #475569;
  --keco-text-muted: #64748b;
  --keco-text-faint: #94a3b8;

  --keco-accent: #326ce5;
  --keco-accent-text: #1e4fbb;
  --keco-accent-soft: #eaf1fe;
  --keco-accent-on: #ffffff;

  --keco-good: #127048;
  --keco-warn: #8a5a0b;
  --keco-bad: #b42318;
  --keco-good-soft: #e9f7f0;
  --keco-warn-soft: #fdf3e3;
  --keco-bad-soft: #fdefed;

  /* Sequential health ramp: one hue, more-is-darker. L* 76.6 → 63.8 → 48.3 → 36.8. */
  --keco-health-1: #a9bee4;
  --keco-health-2: #749cd9;
  --keco-health-3: #3e6fd1;
  --keco-health-4: #1e4fbb;

  --keco-focus: rgb(50 108 229 / 0.35);
  --keco-shadow-card: 0 1px 3px rgb(16 24 40 / 0.05);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;

    --keco-bg: #0e1421;
    --keco-surface: #151d2e;
    --keco-surface-2: #1b2437;
    --keco-border: #212b40;
    --keco-border-strong: #2a3752;

    --keco-text: #f1f4fa;
    --keco-text-2: #aeb9cc;
    --keco-text-muted: #94a3b8;
    --keco-text-faint: #6b7a93;

    --keco-accent: #4c86f0;
    --keco-accent-text: #7ba9ff;
    --keco-accent-soft: rgb(76 134 240 / 0.16);
    --keco-accent-on: #0e1421;

    --keco-good: #5fd8a0;
    --keco-warn: #e3b341;
    --keco-bad: #ff8a7a;
    --keco-good-soft: rgb(26 167 110 / 0.18);
    --keco-warn-soft: rgb(214 158 46 / 0.18);
    --keco-bad-soft: rgb(255 138 122 / 0.16);

    /* On dark the ramp runs the other way: L* 29.3 → 40.7 → 57.0 → 69.3. */
    --keco-health-1: #31456b;
    --keco-health-2: #3e6099;
    --keco-health-3: #4c86f0;
    --keco-health-4: #7ba9ff;

    --keco-focus: rgb(76 134 240 / 0.45);
    /* Dark carries elevation with a surface step, not a shadow. */
    --keco-shadow-card: none;
  }
}

[data-theme='dark'] {
  color-scheme: dark;

  --keco-bg: #0e1421;
  --keco-surface: #151d2e;
  --keco-surface-2: #1b2437;
  --keco-border: #212b40;
  --keco-border-strong: #2a3752;

  --keco-text: #f1f4fa;
  --keco-text-2: #aeb9cc;
  --keco-text-muted: #94a3b8;
  --keco-text-faint: #6b7a93;

  --keco-accent: #4c86f0;
  --keco-accent-text: #7ba9ff;
  --keco-accent-soft: rgb(76 134 240 / 0.16);
  --keco-accent-on: #0e1421;

  --keco-good: #5fd8a0;
  --keco-warn: #e3b341;
  --keco-bad: #ff8a7a;
  --keco-good-soft: rgb(26 167 110 / 0.18);
  --keco-warn-soft: rgb(214 158 46 / 0.18);
  --keco-bad-soft: rgb(255 138 122 / 0.16);

  --keco-health-1: #31456b;
  --keco-health-2: #3e6099;
  --keco-health-3: #4c86f0;
  --keco-health-4: #7ba9ff;

  --keco-focus: rgb(76 134 240 / 0.45);
  --keco-shadow-card: none;
}

/* Layer two: Tailwind reads the variables by reference, so utilities follow the theme. */
@theme inline {
  --color-bg: var(--keco-bg);
  --color-surface: var(--keco-surface);
  --color-surface-2: var(--keco-surface-2);
  --color-line: var(--keco-border);
  --color-line-strong: var(--keco-border-strong);

  --color-fg: var(--keco-text);
  --color-fg-2: var(--keco-text-2);
  --color-muted: var(--keco-text-muted);
  --color-faint: var(--keco-text-faint);

  --color-accent: var(--keco-accent);
  --color-accent-text: var(--keco-accent-text);
  --color-accent-soft: var(--keco-accent-soft);
  --color-accent-on: var(--keco-accent-on);

  --color-good: var(--keco-good);
  --color-warn: var(--keco-warn);
  --color-bad: var(--keco-bad);
  --color-good-soft: var(--keco-good-soft);
  --color-warn-soft: var(--keco-warn-soft);
  --color-bad-soft: var(--keco-bad-soft);

  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;

  --radius-chip: 5px;
  --radius-control: 6px;
  --radius-card: 10px;

  --shadow-card: var(--keco-shadow-card);
}

/*
 * The theme toggle sets [data-theme], so Tailwind's default `dark:` variant — which keys off
 * prefers-color-scheme — would disagree with the attribute. Point it at the attribute instead.
 */
@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));
```

- [ ] **Step 2: Write `apps/web/src/styles/index.css`**

Every `@import` must come before any other statement, which is why the order below is not negotiable.

```css
@import 'tailwindcss';
@import '@fontsource-variable/inter';
@import './theme.css';

@plugin '@tailwindcss/typography';

html {
  background: var(--keco-bg);
}

body {
  background: var(--keco-bg);
  color: var(--keco-text);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--keco-accent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

/*
 * The README is sanitised HTML from apps/api, injected with dangerouslySetInnerHTML. Tailwind's
 * preflight strips every element default, so without `prose` the corpus's documentation — the
 * indexable prose on the SEO surface — renders flat. Typography's own greys are overridden to
 * the palette so the README does not carry a second, unrelated colour system.
 */
.prose-keco {
  --tw-prose-body: var(--keco-text-2);
  --tw-prose-headings: var(--keco-text);
  --tw-prose-links: var(--keco-accent-text);
  --tw-prose-bold: var(--keco-text);
  --tw-prose-counters: var(--keco-text-muted);
  --tw-prose-bullets: var(--keco-border-strong);
  --tw-prose-hr: var(--keco-border);
  --tw-prose-quotes: var(--keco-text-2);
  --tw-prose-quote-borders: var(--keco-border);
  --tw-prose-captions: var(--keco-text-muted);
  --tw-prose-code: var(--keco-text);
  --tw-prose-th-borders: var(--keco-border-strong);
  --tw-prose-td-borders: var(--keco-border);
  max-width: none;
}

/*
 * Shiki highlights server-side and ships its own inline colours. Typography must not fight it:
 * strip the backtick pseudo-elements and let the spans inside `pre` win.
 */
.prose-keco :where(code):not(:where(pre code))::before,
.prose-keco :where(code):not(:where(pre code))::after {
  content: none;
}

.prose-keco :where(code):not(:where(pre code)) {
  background: var(--keco-surface-2);
  border-radius: 4px;
  padding: 0.125rem 0.3rem;
  font-weight: 500;
  font-size: 0.875em;
}

.prose-keco :where(pre) {
  background: var(--keco-surface-2);
  border: 1px solid var(--keco-border);
  color: inherit;
}

.prose-keco :where(pre code) {
  background: none;
  padding: 0;
}

.prose-keco :where(img) {
  border-radius: var(--radius-control);
}
```

- [ ] **Step 3: Import the stylesheet in `apps/web/src/main.tsx`**

Add as the **first** import, above `import { StrictMode } from 'react';`:

```ts
import './styles/index.css';
```

- [ ] **Step 4: Verify the theme compiles and both palettes are reachable**

```bash
mise run web:mock
```

Open `http://localhost:5173`. Expected: Inter, a very light blue-grey page ground, unstyled-but-legible content (no components are themed yet — this step only proves the pipeline works). In devtools, set `document.documentElement.dataset.theme = 'dark'` in the console; the page ground must turn near-black immediately. Set it to `'light'` and it must return. If it does not change, `@theme inline` is wrong — check that `inline` is present.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles apps/web/src/main.tsx
git commit -m "feat(web): add the design tokens and the light/dark theme layers"
```

---

## Task 3: Theme bootstrap and the prerender shell assertion

The inline script must run before first paint, or the 1000 prerendered tool pages flash the wrong theme against real content. Making the shell a contract is exactly what `prerender/html.ts` already does for `<title>` and `#root`.

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/prerender/html.ts`
- Modify: `apps/web/prerender/html.test.ts`

- [ ] **Step 1: Update the test fixture FIRST**

`html.test.ts` builds `SHELL` and calls `toolPageHtml` at module scope. The moment Step 4 adds the assertion, a fixture without the marker throws on import and **every test in the file fails**. So change the fixture before the code.

In `apps/web/prerender/html.test.ts`, add one line to the `SHELL` array, between the `<meta name="description">` line and `'  </head>'`:

```ts
  '    <script>/* keco-theme-bootstrap */</script>',
```

- [ ] **Step 2: Write the failing test**

Append to the `describe('toolPageHtml', …)` block in `apps/web/prerender/html.test.ts`:

```ts
  it('keeps the theme bootstrap script, so a prerendered page cannot flash the wrong theme', () => {
    expect(html).toContain('keco-theme-bootstrap');
  });

  it('fails the build when the shell has lost the theme bootstrap script', () => {
    const withoutScript = SHELL.replace('<script>/* keco-theme-bootstrap */</script>', '');
    expect(() =>
      toolPageHtml(withoutScript, {
        tool,
        markup: '<main><h1>ahmetb/kubectx</h1></main>',
        siteUrl: 'https://keco.dev',
      }),
    ).toThrow(/theme bootstrap/i);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/web/prerender/html.test.ts`
Expected: FAIL — the second test reports "promise resolved instead of rejecting" or "expected function to throw", because no assertion exists yet.

- [ ] **Step 4: Add the assertion to `apps/web/prerender/html.ts`**

Add the constant just below the `FULL_NAME` regex block:

```ts
/**
 * The marker the built shell must still carry. The theme is applied by an inline, pre-paint
 * script in index.html (§9), and a prerendered page has real content to flash — so losing the
 * script is a visible regression on the SEO surface, not a cosmetic one. Same reasoning as the
 * replaceOnce assertions below: fail the build rather than ship 1000 pages that flash white.
 */
const THEME_BOOTSTRAP_MARKER = 'keco-theme-bootstrap';
```

Then add this as the **first** statement inside `toolPageHtml`, above `const { tool, markup, siteUrl } = options;`:

```ts
  if (!shell.includes(THEME_BOOTSTRAP_MARKER)) {
    throw new Error(
      `prerender: the built shell no longer contains the theme bootstrap script (${THEME_BOOTSTRAP_MARKER}). index.html and prerender/html.ts have to agree — see AGENTS.md §9.`,
    );
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/prerender/html.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Add the theme bootstrap script to `apps/web/index.html`**

Insert immediately before `</head>`:

```html
    <script>
      /* keco-theme-bootstrap — must stay inline and blocking; see prerender/html.ts.
         Only an explicit stored choice stamps the attribute. With none, the attribute stays
         absent and the prefers-color-scheme block in theme.css decides, which is why this
         script does not need matchMedia. */
      (function () {
        try {
          var stored = localStorage.getItem('keco-theme');
          if (stored === 'light' || stored === 'dark') {
            document.documentElement.dataset.theme = stored;
          }
        } catch (error) {
          /* Private mode or blocked storage: fall through to the OS preference. */
        }
      })();
    </script>
```

- [ ] **Step 7: Verify no flash on a prerendered-shaped page**

```bash
mise run web:mock
```

In devtools console run `localStorage.setItem('keco-theme','dark')`, then hard-reload. Expected: the page is dark from the very first frame — no white flash. Reload several times to be sure.

- [ ] **Step 8: Commit**

```bash
git add apps/web/index.html apps/web/prerender/html.ts apps/web/prerender/html.test.ts
git commit -m "feat(web): apply the theme before first paint, and assert the shell keeps it"
```

---

## Task 4: `lib/theme.ts`

**Files:**
- Create: `apps/web/src/lib/theme.ts`
- Test: `apps/web/src/lib/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEY, applyTheme, readStoredTheme, resolveTheme } from './theme';

describe('readStoredTheme', () => {
  beforeEach(() => localStorage.clear());

  it('returns a stored preference', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('returns null when nothing is stored', () => {
    expect(readStoredTheme()).toBeNull();
  });

  it('ignores a value that is not a theme, rather than stamping it on the document', () => {
    localStorage.setItem(STORAGE_KEY, 'solarized');
    expect(readStoredTheme()).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('prefers an explicit stored choice over the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('falls through to the system preference when nothing is stored', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
  });
});

describe('applyTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('stamps the attribute and persists the choice', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/theme.test.ts`
Expected: FAIL — "Failed to resolve import './theme'".

If it instead fails with "localStorage is not defined", the vitest environment is not jsdom. Add `// @vitest-environment jsdom` as the first line of the test file.

- [ ] **Step 3: Write `apps/web/src/lib/theme.ts`**

```ts
/**
 * The theme preference, and the only state the toggle owns.
 *
 * The attribute is stamped before paint by the inline script in index.html — this module is
 * what changes it afterwards. Storage is treated as unavailable rather than assumed: private
 * mode and blocked third-party storage both throw on access, and a portal that white-screens
 * because someone hardened their browser is a worse bug than a lost preference.
 */
export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'keco-theme';

const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

export function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Pure, so the precedence rule is testable without a browser. */
export const resolveTheme = (stored: Theme | null, systemPrefersDark: boolean): Theme =>
  stored ?? (systemPrefersDark ? 'dark' : 'light');

export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* The attribute is set either way; only persistence is lost. */
  }
}

/** What the toggle should show on mount: the attribute if the inline script set one, else the OS. */
export function currentTheme(): Theme {
  const stamped = document.documentElement.dataset.theme;
  return isTheme(stamped) ? stamped : resolveTheme(null, systemPrefersDark());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/theme.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/theme.ts apps/web/src/lib/theme.test.ts
git commit -m "feat(web): read and persist the theme preference"
```

---

## Task 5: `paramsFromSelection` and `toggleFacetValue` in `@keco/core`

The sidebar toggles a facet by rewriting the URL, and the URL contract already has a reader (`selectionFromParams`). Its inverse belongs beside it so the two cannot drift.

**Files:**
- Modify: `packages/core/src/read.ts`
- Test: `packages/core/src/read.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/read.test.ts`:

```ts
describe('paramsFromSelection', () => {
  it('round-trips through selectionFromParams', () => {
    const selection = { kind: ['operator'], domains: ['networking', 'security'] };
    expect(selectionFromParams(paramsFromSelection(selection))).toEqual(selection);
  });

  it('preserves non-facet parameters and drops the facets it owns', () => {
    const base = new URLSearchParams('q=ingress&sort=stars&view=grid&kind=cli&page=3');
    const next = paramsFromSelection({ kind: ['operator'] }, base);

    expect(next.get('q')).toBe('ingress');
    expect(next.get('sort')).toBe('stars');
    expect(next.get('view')).toBe('grid');
    expect(next.getAll('kind')).toEqual(['operator']);
  });

  it('removes a family entirely when nothing in it is selected', () => {
    const base = new URLSearchParams('kind=cli&domains=security');
    const next = paramsFromSelection({ kind: ['cli'] }, base);

    expect(next.getAll('kind')).toEqual(['cli']);
    expect(next.has('domain')).toBe(false);
    expect(next.has('domains')).toBe(false);
  });

  it('does not mutate the base it was given', () => {
    const base = new URLSearchParams('kind=cli');
    paramsFromSelection({ kind: ['operator'] }, base);
    expect(base.getAll('kind')).toEqual(['cli']);
  });
});

describe('toggleFacetValue', () => {
  it('adds a value that is not selected', () => {
    expect(toggleFacetValue({}, 'kind', 'operator')).toEqual({ kind: ['operator'] });
  });

  it('removes a value that is selected', () => {
    expect(toggleFacetValue({ kind: ['operator'] }, 'kind', 'operator')).toEqual({});
  });

  it('keeps other values in the same family', () => {
    const next = toggleFacetValue({ domains: ['networking', 'security'] }, 'domains', 'security');
    expect(next).toEqual({ domains: ['networking'] });
  });

  it('does not mutate the selection it was given', () => {
    const selection = { kind: ['operator'] };
    toggleFacetValue(selection, 'kind', 'cli');
    expect(selection).toEqual({ kind: ['operator'] });
  });
});
```

Add `paramsFromSelection` and `toggleFacetValue` to the file's existing import from `./read`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/read.test.ts`
Expected: FAIL — "paramsFromSelection is not a function".

- [ ] **Step 3: Implement in `packages/core/src/read.ts`**

Add directly below `selectionFromParams`:

```ts
/**
 * The inverse of `selectionFromParams`, and deliberately adjacent to it: the portal's sidebar
 * writes the URL that the same file reads back, so a change to one that is not mirrored in the
 * other is caught by a round-trip test rather than by a reader with a broken filter.
 *
 * Every family's parameter is cleared before the selection is written, so a value removed from
 * the selection leaves the URL. Everything else on `base` — `q`, `sort`, `view` — survives
 * untouched. `page` is dropped: changing a filter invalidates the page number, and silently
 * landing a reader on page 4 of a 2-page result set is the bug that causes.
 */
export function paramsFromSelection(
  selection: FacetSelection,
  base?: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(base);

  for (const taxonomyFamily of TAXONOMY) next.delete(taxonomyFamily.param);
  next.delete('page');

  for (const taxonomyFamily of TAXONOMY) {
    for (const value of selection[taxonomyFamily.id] ?? []) {
      next.append(taxonomyFamily.param, value);
    }
  }

  return next;
}

/** Add or remove one value, returning a new selection. Empty families are dropped, not left as []. */
export function toggleFacetValue(
  selection: FacetSelection,
  familyId: string,
  value: string,
): FacetSelection {
  const current = selection[familyId] ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];

  const result: FacetSelection = { ...selection };
  if (next.length) result[familyId] = next;
  else delete result[familyId];
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/read.test.ts`
Expected: PASS, including the 8 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/read.ts packages/core/src/read.test.ts
git commit -m "feat(core): write a facet selection back to the URL it was read from"
```

---

## Task 6: `lib/facets.ts`

**Files:**
- Create: `apps/web/src/lib/facets.ts`
- Test: `apps/web/src/lib/facets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { COLLAPSE_AFTER, facetGroups } from './facets';

describe('facetGroups', () => {
  it('drops values with no documents behind them', () => {
    const groups = facetGroups({ kind: { operator: 12, cli: 0 } }, {});
    const kind = groups.find((group) => group.familyId === 'kind');

    expect(kind?.options.map((option) => option.id)).toEqual(['operator']);
  });

  it('renders no group at all for a family with no hits', () => {
    expect(facetGroups({ kind: {} }, {})).toEqual([]);
  });

  it('reads install methods from the nested filterable attribute', () => {
    const groups = facetGroups({ 'install_methods.method': { krew: 4 } }, {});

    expect(groups.map((group) => group.familyId)).toContain('install_methods');
  });

  it('marks selected values and counts them', () => {
    const groups = facetGroups({ kind: { operator: 12, cli: 3 } }, { kind: ['operator'] });
    const kind = groups.find((group) => group.familyId === 'kind');

    expect(kind?.options.find((option) => option.id === 'operator')?.selected).toBe(true);
    expect(kind?.options.find((option) => option.id === 'cli')?.selected).toBe(false);
    expect(kind?.selectedCount).toBe(1);
  });

  it('orders values by count, descending', () => {
    const groups = facetGroups({ kind: { cli: 3, operator: 12, controller: 7 } }, {});

    expect(groups[0]?.options.map((option) => option.id)).toEqual(['operator', 'controller', 'cli']);
  });

  it('keeps a selected value visible even when its count would bury it', () => {
    const counts: Record<string, number> = {};
    for (const value of ['cli', 'operator', 'controller', 'helm-chart', 'crd-library', 'dashboard-ui']) {
      counts[value] = 50;
    }
    counts['learning-resource'] = 1;

    const groups = facetGroups({ kind: counts }, { kind: ['learning-resource'] });
    const visible = groups[0]?.options.slice(0, COLLAPSE_AFTER) ?? [];

    expect(visible.some((option) => option.id === 'learning-resource')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/facets.test.ts`
Expected: FAIL — "Failed to resolve import './facets'".

- [ ] **Step 3: Write `apps/web/src/lib/facets.ts`**

```ts
import {
  facetableFamilies,
  family,
  familyAttribute,
  paramForFamily,
  values,
  type FacetSelection,
} from '@keco/core';

/**
 * The search sidebar's view model — the counterpart to `topics.ts`, which does the same job
 * for the home page's chip rows, and pure for the same reason: the branching lives here where
 * it can be tested without a DOM, and the .tsx holds markup only.
 *
 * No new query pays for this. `searchTools()` already asks Meilisearch for
 * `facets: defaultFacets()` and already returns the distribution; the search page simply
 * ignored it until now.
 *
 * Nothing here enumerates a taxonomy family's values — the vocabulary is data (§6), so a ninth
 * family appears in the sidebar by editing the YAML and nothing else.
 */
export type FacetOption = {
  id: string;
  label: string;
  description: string;
  count: number;
  selected: boolean;
};

export type FacetGroup = {
  familyId: string;
  label: string;
  param: string;
  options: FacetOption[];
  selectedCount: number;
};

/** Values past this are folded behind "Show N more". */
export const COLLAPSE_AFTER = 5;

export function facetGroups(
  distribution: Record<string, Record<string, number>>,
  selection: FacetSelection,
): FacetGroup[] {
  const groups: FacetGroup[] = [];

  for (const familyId of facetableFamilies()) {
    const counts = distribution[familyAttribute(familyId)] ?? {};
    const selected = selection[familyId] ?? [];

    const options = values(familyId)
      .map((value) => ({
        id: value.id,
        label: value.label,
        description: value.description,
        count: counts[value.id] ?? 0,
        selected: selected.includes(value.id),
      }))
      // A zero-count value is a dead checkbox: it can only ever produce an empty result set.
      // A *selected* zero-count value is different — it is why the set is empty, so it stays,
      // or the reader cannot see the filter they need to remove.
      .filter((option) => option.count > 0 || option.selected)
      // Selected first, so a filter never hides below the collapse threshold that it caused.
      .sort((a, b) => Number(b.selected) - Number(a.selected) || b.count - a.count);

    if (options.length === 0) continue;

    const definition = family(familyId);
    groups.push({
      familyId,
      label: definition.label,
      param: paramForFamily(familyId),
      options,
      selectedCount: selected.length,
    });
  }

  return groups;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/facets.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/facets.ts apps/web/src/lib/facets.test.ts
git commit -m "feat(web): build the facet sidebar view model from the existing distribution"
```

---

## Task 7: `lib/keyboard.ts`

**Files:**
- Create: `apps/web/src/lib/keyboard.ts`
- Test: `apps/web/src/lib/keyboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { isEditableTarget, nextFocusIndex } from './keyboard';

describe('nextFocusIndex', () => {
  it('enters the list from nothing focused', () => {
    expect(nextFocusIndex(null, 'next', 5)).toBe(0);
    expect(nextFocusIndex(null, 'previous', 5)).toBe(4);
  });

  it('moves within the list', () => {
    expect(nextFocusIndex(2, 'next', 5)).toBe(3);
    expect(nextFocusIndex(2, 'previous', 5)).toBe(1);
  });

  it('clamps rather than wrapping, so the ends are reachable and stable', () => {
    expect(nextFocusIndex(4, 'next', 5)).toBe(4);
    expect(nextFocusIndex(0, 'previous', 5)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(nextFocusIndex(null, 'next', 0)).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('is true for text entry, so "/" does not hijack a keystroke', () => {
    expect(isEditableTarget({ tagName: 'INPUT', isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for ordinary elements and for nothing at all', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/keyboard.test.ts`
Expected: FAIL — "Failed to resolve import './keyboard'".

- [ ] **Step 3: Write `apps/web/src/lib/keyboard.ts`**

```ts
/**
 * Keyboard navigation for the result list (AGENTS.md §9), as pure functions so the rules are
 * testable without a DOM and the component that binds them holds no branching.
 *
 * Roving tabindex rather than aria-activedescendant: results are links, and a genuinely
 * focused link gets Enter, middle-click and "open in new tab" from the browser instead of
 * from handlers we would have to write and would get subtly wrong.
 */
export type FocusMove = 'next' | 'previous';

/**
 * Clamps at the end and returns null past the start. The asymmetry is deliberate: ↑ from the
 * first result should return the reader to the search field, and wrapping to the last result
 * would instead scroll them to the bottom of the page.
 */
export function nextFocusIndex(
  current: number | null,
  move: FocusMove,
  count: number,
): number | null {
  if (count === 0) return null;
  if (current === null) return move === 'next' ? 0 : count - 1;

  const next = move === 'next' ? current + 1 : current - 1;
  if (next < 0) return null;
  return Math.min(next, count - 1);
}

/** Typed loosely so it can be tested with plain objects rather than a synthetic DOM. */
type MaybeEditable = { tagName?: string; isContentEditable?: boolean } | null;

/** `/` focuses search — unless the reader is already typing, where it must stay a slash. */
export function isEditableTarget(target: MaybeEditable): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/keyboard.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/keyboard.ts apps/web/src/lib/keyboard.test.ts
git commit -m "feat(web): add the roving-focus rules for result navigation"
```

---

## Task 8: Primitives

No tests: these are markup with no branching worth asserting. Verification is visual.

**Files:**
- Create: `apps/web/src/components/primitives/chip.tsx`
- Create: `apps/web/src/components/primitives/status-pill.tsx`
- Create: `apps/web/src/components/primitives/meter.tsx`
- Create: `apps/web/src/components/primitives/copy-button.tsx`
- Create: `apps/web/src/components/primitives/kbd.tsx`

- [ ] **Step 1: Write `chip.tsx`**

```tsx
import { Link } from 'react-router';

/**
 * A taxonomy value. Neutral by default and accent-tinted only when selected: colour here
 * encodes interaction state, never category. Eight facetable families is already past the
 * point where categorical hues stay distinguishable — the palette validator rejected the
 * family-coloured version outright (violet↔blue ΔE 1.4 under deuteranopia). See the spec.
 */
type ChipProps = {
  label: string;
  count?: number;
  to?: string;
  title?: string;
  selected?: boolean;
};

const base =
  'inline-flex items-center gap-1.5 rounded-chip px-2 py-0.5 text-xs transition-colors';

export function Chip({ label, count, to, title, selected = false }: ChipProps) {
  const tone = selected
    ? 'bg-accent-soft text-accent-text ring-1 ring-accent/30'
    : 'bg-surface-2 text-fg-2 hover:text-fg';

  const body = (
    <>
      {label}
      {count !== undefined && <span className="font-mono text-faint tabular-nums">{count}</span>}
    </>
  );

  if (!to) return <span className={`${base} ${tone}`}>{body}</span>;

  return (
    <Link to={to} title={title} className={`${base} ${tone}`}>
      {body}
    </Link>
  );
}
```

- [ ] **Step 2: Write `status-pill.tsx`**

```tsx
/**
 * Genuine state — archived, open vulnerabilities, needs review. Never a score.
 *
 * Every pill carries an icon *and* a word, so the status is never colour alone. Green/amber/red
 * is reserved for this component precisely so that a health score cannot borrow it: §4.4's
 * "missing ≠ bad" is incompatible with painting a repo red because OpenSSF never scanned it.
 */
type Tone = 'good' | 'warn' | 'bad';

const TONES: Record<Tone, { className: string; icon: string }> = {
  good: { className: 'bg-good-soft text-good', icon: '✓' },
  warn: { className: 'bg-warn-soft text-warn', icon: '⚠' },
  bad: { className: 'bg-bad-soft text-bad', icon: '✕' },
};

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const { className, icon } = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-xs font-semibold ${className}`}
    >
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}
```

- [ ] **Step 3: Write `meter.tsx`**

```tsx
/**
 * A 0–1 magnitude. One hue, more-is-darker — four discrete steps rather than a continuous
 * interpolation, so the same score always paints the same colour.
 *
 * The bar is decoration: `role="img"` plus a label is what a screen reader gets, and every
 * caller renders the number beside it. Colour is reinforcement, never the only encoding.
 */
const STEPS = [
  { max: 0.4, className: 'bg-[var(--keco-health-1)]' },
  { max: 0.65, className: 'bg-[var(--keco-health-2)]' },
  { max: 0.85, className: 'bg-[var(--keco-health-3)]' },
  { max: Infinity, className: 'bg-[var(--keco-health-4)]' },
];

export const healthClass = (value: number): string =>
  (STEPS.find((step) => value < step.max) ?? STEPS[STEPS.length - 1]).className;

type MeterProps = {
  value: number;
  label: string;
  /** Share of the axis that could be scored at all — drawn as a dashed ceiling. */
  coverage?: number;
  className?: string;
};

export function Meter({ value, label, coverage, className = '' }: MeterProps) {
  const percent = Math.max(0, Math.min(1, value)) * 100;

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`${label}: ${value.toFixed(2)} out of 1.00`}
        className="relative h-1.5 w-full overflow-hidden rounded-[3px] bg-surface-2"
      >
        <span
          className={`block h-full rounded-r-[3px] ${healthClass(value)}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {coverage !== undefined && coverage < 1 && (
        <div
          className="mt-0.5 h-0.5 rounded-full"
          style={{
            width: `${Math.max(0, Math.min(1, coverage)) * 100}%`,
            backgroundImage:
              'repeating-linear-gradient(90deg, var(--keco-border-strong) 0 3px, transparent 3px 6px)',
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write `copy-button.tsx`**

```tsx
import { useState } from 'react';

/**
 * Copies a verified install command. The command comes from the document's `install_methods`
 * and is never constructed here — §6 names a fabricated `brew install` line as the worst bug
 * this project can ship, because people paste these straight into a terminal.
 */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="shrink-0 rounded-control border border-line-strong px-2 py-0.5 text-xs text-muted transition-colors hover:text-fg"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          // A denied clipboard permission is not worth an error state; the command is on screen.
          () => undefined,
        );
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
```

- [ ] **Step 5: Write `kbd.tsx`**

```tsx
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
```

- [ ] **Step 6: Verify it typechecks**

Run: `mise run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/primitives
git commit -m "feat(web): add the chip, status pill, meter, copy button and kbd primitives"
```

---

## Task 9: Application shell

**Files:**
- Create: `apps/web/src/components/shell/theme-toggle.tsx`
- Create: `apps/web/src/components/shell/site-header.tsx`
- Create: `apps/web/src/components/shell/site-footer.tsx`
- Create: `apps/web/src/components/shell/app-shell.tsx`
- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: Write `theme-toggle.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { applyTheme, currentTheme, type Theme } from '../../lib/theme';

/**
 * Reads its initial value from the attribute the inline script in index.html already stamped,
 * so the control can never disagree with what is on screen. `useEffect` rather than an
 * initialiser because the prerender runs this component under renderToString, where there is
 * no document — the button renders in its light state and corrects itself on hydration.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => setTheme(currentTheme()), []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      aria-label={`Switch to the ${next} theme`}
      aria-pressed={theme === 'dark'}
      className="rounded-control border border-line px-2 py-1 text-sm text-muted transition-colors hover:text-fg"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
```

- [ ] **Step 2: Write `site-header.tsx`**

```tsx
import { Link, useLocation, useNavigate } from 'react-router';
import { ThemeToggle } from './theme-toggle';

/**
 * The compact search field is omitted on `/`, where the hero field is the page's subject and a
 * second one would be two controls competing for the same job.
 */
export function SiteHeader() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const isHome = pathname === '/';
  const query = new URLSearchParams(search).get('q') ?? '';

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface">
      <div className="mx-auto flex max-w-[1200px] items-center gap-4 px-4 py-2.5">
        <Link to="/" className="flex shrink-0 items-center gap-2 text-[15px] font-bold tracking-tight text-fg">
          <span
            aria-hidden="true"
            className="inline-block h-5 w-[18px] bg-accent"
            style={{ clipPath: 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)' }}
          />
          Keco
        </Link>

        {!isHome && (
          <form
            className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-line-strong bg-bg px-3 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get('q');
              void navigate(`/search?q=${encodeURIComponent(typeof value === 'string' ? value : '')}`);
            }}
          >
            <span aria-hidden="true" className="text-faint">⌕</span>
            <input
              name="q"
              type="search"
              defaultValue={query}
              aria-label="Search the Kubernetes ecosystem"
              placeholder="Search the ecosystem"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </form>
        )}

        <div className="ml-auto shrink-0">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Write `site-footer.tsx`**

The footer holds no data fetch. `renderToString` does not run effects, so a footer that queried would render empty into all 1000 prerendered pages and only fill in after hydration. Corpus freshness belongs where a query already happens — the home page and the tool page.

```tsx
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-6 text-xs leading-relaxed text-muted">
        <p>
          Keco classifies and ranks the Kubernetes ecosystem from public GitHub data. Everything
          here is derived — there is no curation and no editorial content.
        </p>
        <p className="mt-1 text-faint">
          Scores are computed from repository metadata and public signals. Install commands are
          listed only where they are verified against a registry.
        </p>
      </div>
    </footer>
  );
}
```

- [ ] **Step 4: Write `app-shell.tsx`**

```tsx
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:m-2 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      <SiteHeader />
      <div id="content" className="flex-1">
        {children}
      </div>
      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 5: Wrap the routes in `apps/web/src/app.tsx`**

Add the import and wrap `<Routes>`:

```tsx
import { AppShell } from './components/shell/app-shell';
```

```tsx
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/tools/:owner/:repo" element={<ToolPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
```

- [ ] **Step 6: Verify the shell renders in both themes and in the prerender**

```bash
mise run web:mock
```

Expected: a sticky header with the hexagon mark and a working theme toggle on every route; the header search field absent on `/` and present elsewhere; Tab from the top of the page reveals "Skip to content".

Then confirm the prerender still runs under `renderToString`, where there is no `document`:

Run: `pnpm vitest run apps/web/prerender`
Expected: PASS. If `ThemeToggle` throws "document is not defined", the `currentTheme()` call escaped `useEffect` — put it back.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/shell apps/web/src/app.tsx
git commit -m "feat(web): add the application shell, header and theme toggle"
```

---

## Task 10: Home page

**Files:**
- Modify: `apps/web/src/lib/search.ts`
- Modify: `apps/web/src/routes/home.tsx`
- Modify: `apps/web/src/components/topic-chips.tsx`

- [ ] **Step 1: Return the corpus size from `browseFacets`**

The query already computes it. In `apps/web/src/lib/search.ts`, change `browseFacets` to:

```ts
/**
 * The facet distribution for every family, with no hits: `hitsPerPage: 0` buys the counts the
 * Browse rows need and nothing else (§9). `total` comes free from the same response, and is
 * what lets the home page report corpus size without a second round trip.
 */
export async function browseFacets(): Promise<{
  facets: Record<string, Record<string, number>>;
  total: number;
}> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({}),
    facets: defaultFacets(),
    hitsPerPage: 0,
  });
  return {
    facets: response.facetDistribution ?? {},
    total: response.totalHits ?? 0,
  };
}
```

- [ ] **Step 2: Rewrite `apps/web/src/routes/home.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { TopicChips } from '../components/topic-chips';
import { Kbd } from '../components/primitives/kbd';
import { Meter } from '../components/primitives/meter';
import { formatUtcDate } from '../lib/dates';
import { browseFacets, searchErrorMessage, whatsHot } from '../lib/search';
import { chipRows, type ChipRow } from '../lib/topics';

/**
 * Home (AGENTS.md §9): a hero search field, then Browse — one chip row per facetable family,
 * built from the `tools` facet distribution — then Highest momentum.
 *
 * Both queries go straight to Meilisearch from the browser (§9). They are issued together
 * because neither depends on the other, and the facet query costs one request whether or not
 * the momentum list is on the page.
 */
export function HomePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ChipRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hot, setHot] = useState<ToolDocument[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([browseFacets(), whatsHot(12)])
      .then(([browse, tools]) => {
        if (cancelled) return;
        setRows(chipRows(browse.facets));
        setTotal(browse.total);
        setHot(tools);
      })
      // A blank SPA tells the reader nothing. Say what failed (§9 empty states) — and say it
      // precisely: "not configured" and "down" are different problems (§12).
      .catch((error: unknown) => !cancelled && setError(searchErrorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, []);

  const freshest = hot[0]?.indexed_at;

  return (
    <main className="mx-auto max-w-[1200px] px-4">
      <section className="py-14 text-center">
        <h1 className="text-[32px] font-bold leading-tight tracking-tight text-fg sm:text-[40px]">
          Find the right Kubernetes tool in 10 seconds
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-muted">
          Ranked by health — maintenance, releases, security posture — not by stars.
        </p>

        <form
          className="mx-auto mt-7 flex max-w-[560px] items-center gap-2.5 rounded-card border-[1.5px] border-accent bg-surface px-3.5 py-2.5 shadow-[0_4px_14px_rgb(50_108_229/0.13)]"
          onSubmit={(event) => {
            event.preventDefault();
            const q = new FormData(event.currentTarget).get('q');
            void navigate(`/search?q=${encodeURIComponent(typeof q === 'string' ? q : '')}`);
          }}
        >
          <label htmlFor="q" className="sr-only">
            Search the Kubernetes ecosystem
          </label>
          <span aria-hidden="true" className="text-accent">⌕</span>
          <input
            id="q"
            name="q"
            type="search"
            placeholder="ingress controller, cost, backup…"
            className="min-w-0 flex-1 bg-transparent text-left text-sm outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            className="shrink-0 rounded-control bg-accent px-3 py-1 text-xs font-semibold text-accent-on"
          >
            Search
          </button>
        </form>

        {total !== null && (
          <p className="mt-3 text-xs text-faint">
            <span className="font-mono tabular-nums">{total.toLocaleString('en-GB')}</span>{' '}
            repositories classified
            {freshest && <> · updated {formatUtcDate(freshest)}</>}
          </p>
        )}
      </section>

      {error && (
        <p role="alert" className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-bad">
          {error}
        </p>
      )}

      {/* Renders nothing until the first crawl has filled the index. */}
      <TopicChips rows={rows} />

      {hot.length > 0 && (
        <section className="py-10">
          {/* "Momentum", never "trending this week": there is no history to measure (§4.4). */}
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="text-[15px] font-bold tracking-tight text-fg">Highest momentum</h2>
            <span className="text-xs text-faint">stars per day of age, damped by activity</span>
          </div>

          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {hot.map((tool) => (
              <li key={tool.id}>
                <Link
                  to={`/tools/${tool.full_name}`}
                  className="block h-full rounded-card border border-line bg-surface p-3.5 shadow-card transition-colors hover:border-accent"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-accent-text">{tool.name}</span>
                    <span className="ml-auto font-mono text-xs tabular-nums text-muted">
                      {tool.score.total.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-faint">{tool.owner}</div>
                  <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-fg-2">
                    {tool.summary}
                  </p>
                  <Meter value={tool.score.total} label={`${tool.full_name} health`} className="mt-2.5" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="pb-4 text-xs text-faint">
        Press <Kbd>/</Kbd> anywhere to search.
      </p>
    </main>
  );
}
```

- [ ] **Step 3: Restyle `topic-chips.tsx`**

Keep the component's logic and comment exactly as they are; change only the returned markup:

```tsx
  return (
    <section aria-labelledby="browse" className="py-8">
      <h2 id="browse" className="mb-4 text-[15px] font-bold tracking-tight text-fg">
        Browse
      </h2>
      <div className="space-y-4">
        {rows.map((row) => (
          <nav key={row.familyId} aria-label={row.label}>
            <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
              {row.label}
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {row.chips.map((chip) => (
                <li key={chip.id}>
                  <Chip label={chip.label} count={chip.count} to={chip.href} title={chip.description} />
                </li>
              ))}
              {row.moreHref && (
                <li>
                  <Link to={row.moreHref} className="px-2 py-0.5 text-xs text-accent-text">
                    more →
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        ))}
      </div>
    </section>
  );
```

Add `import { Chip } from './primitives/chip';` at the top.

- [ ] **Step 4: Verify**

```bash
mise run web:mock
```

Expected at `http://localhost:5173/`: a centred hero, a corpus count, chip rows per family, and a three-column momentum grid whose cards each carry a meter. Toggle the theme and confirm every surface follows.

Run: `pnpm vitest run apps/web/src/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/home.tsx apps/web/src/components/topic-chips.tsx apps/web/src/lib/search.ts
git commit -m "feat(web): style the home page and report corpus size and freshness"
```

---

## Task 11: Search page — sidebar, active filters and controls

**Files:**
- Create: `apps/web/src/components/search/facet-sidebar.tsx`
- Create: `apps/web/src/components/search/active-filters.tsx`
- Create: `apps/web/src/components/search/search-controls.tsx`

- [ ] **Step 1: Write `facet-sidebar.tsx`**

```tsx
import { COLLAPSE_AFTER, type FacetGroup } from '../../lib/facets';
import { Kbd } from '../primitives/kbd';

/**
 * One group per facetable family with hits, from the distribution `searchTools()` already
 * returns. Values past COLLAPSE_AFTER fold into a `<details>` — native, keyboard-navigable and
 * working before the bundle loads, which no custom disclosure would be.
 */
type Props = {
  groups: FacetGroup[];
  onToggle: (familyId: string, value: string) => void;
  onClear: () => void;
  hasSelection: boolean;
};

function Option({
  option,
  onToggle,
}: {
  option: FacetGroup['options'][number];
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-2 hover:text-fg">
      <input
        type="checkbox"
        checked={option.selected}
        onChange={onToggle}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--keco-accent)]"
      />
      <span className="min-w-0 truncate" title={option.description}>
        {option.label}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-faint">
        {option.count}
      </span>
    </label>
  );
}

export function FacetSidebar({ groups, onToggle, onClear, hasSelection }: Props) {
  if (groups.length === 0) return null;

  return (
    <aside className="border-line lg:border-r lg:pr-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-fg">Filters</h2>
        {hasSelection && (
          <button type="button" onClick={onClear} className="text-[11px] text-accent-text">
            Clear all
          </button>
        )}
      </div>

      <div className="space-y-4">
        {groups.map((group) => {
          const visible = group.options.slice(0, COLLAPSE_AFTER);
          const rest = group.options.slice(COLLAPSE_AFTER);

          return (
            <fieldset key={group.familyId}>
              <legend className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
                {group.label}
              </legend>
              <div className="space-y-1">
                {visible.map((option) => (
                  <Option
                    key={option.id}
                    option={option}
                    onToggle={() => onToggle(group.familyId, option.id)}
                  />
                ))}
              </div>
              {rest.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-accent-text">
                    Show {rest.length} more
                  </summary>
                  <div className="mt-1 space-y-1">
                    {rest.map((option) => (
                      <Option
                        key={option.id}
                        option={option}
                        onToggle={() => onToggle(group.familyId, option.id)}
                      />
                    ))}
                  </div>
                </details>
              )}
            </fieldset>
          );
        })}
      </div>

      <p className="mt-5 text-[10px] leading-relaxed text-faint">
        <Kbd>↑↓</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>/</Kbd> search
      </p>
    </aside>
  );
}
```

- [ ] **Step 2: Write `active-filters.tsx`**

```tsx
import type { FacetGroup } from '../../lib/facets';

/**
 * The current selection, each chip naming its family. The family is in the label rather than
 * in the colour because eight families cannot be told apart by hue — see the spec.
 */
export function ActiveFilters({
  groups,
  onToggle,
}: {
  groups: FacetGroup[];
  onToggle: (familyId: string, value: string) => void;
}) {
  const active = groups.flatMap((group) =>
    group.options
      .filter((option) => option.selected)
      .map((option) => ({ group, option })),
  );

  if (active.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-2">
      {active.map(({ group, option }) => (
        <li key={`${group.familyId}:${option.id}`}>
          <button
            type="button"
            onClick={() => onToggle(group.familyId, option.id)}
            className="inline-flex items-center gap-1.5 rounded-control border border-accent/25 bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent-text"
          >
            <span className="lowercase">{group.label}</span>: {option.label}
            <span aria-hidden="true" className="opacity-55">×</span>
            <span className="sr-only">Remove this filter</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Write `search-controls.tsx`**

```tsx
import { isSortKey, type SortKey } from '@keco/core';

/**
 * Sort and the list/grid toggle. Both write the URL, which §9 already declares as the state
 * store for this page (`?q=&kind=&domain=&install=&sort=&view=`).
 */
export type ViewMode = 'list' | 'grid';

export const isViewMode = (value: string): value is ViewMode => value === 'list' || value === 'grid';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'score', label: 'Health' },
  { value: 'momentum', label: 'Momentum' },
  { value: 'stars', label: 'Stars' },
  { value: 'recent', label: 'Recently pushed' },
];

export function SearchControls({
  sort,
  view,
  onSort,
  onView,
}: {
  sort: SortKey;
  view: ViewMode;
  onSort: (next: SortKey) => void;
  onView: (next: ViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="sort">
        Sort results
      </label>
      <select
        id="sort"
        value={sort}
        onChange={(event) => isSortKey(event.target.value) && onSort(event.target.value)}
        className="rounded-control border border-line-strong bg-surface px-2 py-1 text-[11.5px] text-fg-2"
      >
        {SORTS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <div className="flex overflow-hidden rounded-control border border-line-strong">
        {(['list', 'grid'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={view === mode}
            onClick={() => onView(mode)}
            className={`px-2 py-1 text-[11.5px] ${
              view === mode ? 'bg-accent text-accent-on' : 'bg-surface text-muted'
            }`}
          >
            <span aria-hidden="true">{mode === 'list' ? '☰' : '▦'}</span>
            <span className="sr-only">{mode === 'list' ? 'List view' : 'Grid view'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify it typechecks**

Run: `mise run check`
Expected: PASS. Nothing renders these yet — Task 13 wires them.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/search
git commit -m "feat(web): add the facet sidebar, active filters and search controls"
```

---

## Task 12: Search page — result card and empty states

**Files:**
- Create: `apps/web/src/components/search/result-card.tsx`
- Create: `apps/web/src/components/search/empty-state.tsx`

- [ ] **Step 1: Write `result-card.tsx`**

```tsx
import { forwardRef } from 'react';
import { Link } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { formatUtcDate } from '../../lib/dates';
import { Chip } from '../primitives/chip';
import { Meter } from '../primitives/meter';
import { StatusPill } from '../primitives/status-pill';

/**
 * One result. `forwardRef` because the search page drives focus through a roving tabindex and
 * needs the anchor itself — results are links, so a focused one gets Enter, middle-click and
 * "open in new tab" from the browser rather than from handlers we would have to reimplement.
 */
type Props = {
  tool: ToolDocument;
  view: 'list' | 'grid';
  tabIndex: number;
};

export const ResultCard = forwardRef<HTMLAnchorElement, Props>(function ResultCard(
  { tool, view, tabIndex },
  ref,
) {
  const meta = [
    `★ ${tool.stars.toLocaleString('en-GB')}`,
    tool.language,
    tool.license,
    `pushed ${formatUtcDate(tool.pushed_at)}`,
  ].filter(Boolean);

  return (
    <Link
      ref={ref}
      to={`/tools/${tool.full_name}`}
      tabIndex={tabIndex}
      className="block rounded-card border border-line bg-surface p-3.5 shadow-card transition-colors hover:border-accent focus-visible:border-accent"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[14.5px] font-semibold text-accent-text">{tool.name}</span>
        <span className="text-[11.5px] text-faint">{tool.owner}</span>
        {tool.archived && <StatusPill tone="warn">Archived</StatusPill>}
        {tool.needs_review && <StatusPill tone="warn">Needs review</StatusPill>}
        {/* `signals` is required on ToolDocument; `osv` is nullable. Optional-chain the second only. */}
        {tool.signals.osv !== null && tool.signals.osv.open_vulns > 0 && (
          <StatusPill tone="bad">{tool.signals.osv.open_vulns} open CVEs</StatusPill>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Meter value={tool.score.total} label={`${tool.full_name} health`} className="w-16" />
          <span className="font-mono text-xs font-semibold tabular-nums text-accent-text">
            {tool.score.total.toFixed(2)}
          </span>
        </div>
      </div>

      <p className={`mt-1.5 text-[12.5px] leading-relaxed text-fg-2 ${view === 'grid' ? 'line-clamp-3' : ''}`}>
        {tool.summary}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Chip label={`kind: ${tool.kind}`} />
        {tool.domains.slice(0, 2).map((domain) => (
          <Chip key={domain} label={domain} />
        ))}
        <span className="ml-auto font-mono text-[11px] text-muted">{meta.join(' · ')}</span>
      </div>
    </Link>
  );
});
```

- [ ] **Step 2: Write `empty-state.tsx`**

```tsx
import { Link } from 'react-router';

/**
 * Empty and zero-result states must suggest something useful (§9). An empty index is the
 * normal state before the first crawl, not a failure, and must not read like one.
 */
export function NoResults({ query }: { query: string }) {
  return (
    <section className="rounded-card border border-line bg-surface px-5 py-8 text-center">
      <h2 className="text-[15px] font-semibold text-fg">
        {query ? `Nothing matches “${query}”` : 'Nothing here yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
        Try a broader term, or drop a filter. You can also browse{' '}
        <Link to="/search?kind=operator" className="text-accent-text">operators</Link>,{' '}
        <Link to="/search?domain=observability" className="text-accent-text">observability</Link> or{' '}
        <Link to="/search?install=krew" className="text-accent-text">kubectl plugins</Link>.
      </p>
    </section>
  );
}

export function SearchError({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-card border border-line bg-surface px-4 py-3">
      <p className="text-sm font-medium text-bad">{message}</p>
    </div>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `mise run check`
Expected: PASS.

Field names used here are verified against `packages/core/src/schemas.ts`: `forks`, `needs_review`, `archived` and `score` are required; `language` and `license` are `nullable`; `signals` is required while `signals.osv` is `nullable`. Do not cast to `any` if something surprises you — §13 bans it outside verbatim cached GitHub payloads.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/search
git commit -m "feat(web): add the result card and the search empty states"
```

---

## Task 13: Search page — wire it together, including keyboard navigation

**Files:**
- Modify: `apps/web/src/routes/search.tsx`

- [ ] **Step 1: Rewrite `apps/web/src/routes/search.tsx`**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  isSortKey,
  paramsFromSelection,
  selectionFromParams,
  toggleFacetValue,
  type SortKey,
} from '@keco/core';
import { ActiveFilters } from '../components/search/active-filters';
import { NoResults, SearchError } from '../components/search/empty-state';
import { FacetSidebar } from '../components/search/facet-sidebar';
import { ResultCard } from '../components/search/result-card';
import { isViewMode, SearchControls, type ViewMode } from '../components/search/search-controls';
import { facetGroups } from '../lib/facets';
import { isEditableTarget, nextFocusIndex } from '../lib/keyboard';
import { searchErrorMessage, searchTools, type PortalSearchResult } from '../lib/search';

/**
 * Search (AGENTS.md §9). State lives in the URL (`?q=&kind=&domain=&install=&sort=&view=`) so
 * results are shareable and back/forward work — `useSearchParams` is the only state store on
 * this page, deliberately.
 *
 * Every taxonomy family is readable from the URL by its declared `param`
 * (`selectionFromParams`) and written back by `paramsFromSelection`, so adding a family needs
 * no change here (§6).
 */
const DEBOUNCE_MS = 80;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [results, setResults] = useState<PortalSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<number | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  const q = params.get('q') ?? '';
  const sortParam = params.get('sort') ?? '';
  const sort: SortKey = isSortKey(sortParam) ? sortParam : 'relevance';
  const viewParam = params.get('view') ?? '';
  const view: ViewMode = isViewMode(viewParam) ? viewParam : 'list';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  // The URL is untrusted input: narrow it rather than casting (§14).
  const key = params.toString();
  const selection = useMemo(() => selectionFromParams(params), [key]);

  useEffect(() => {
    let cancelled = false;
    // ~80 ms, so search-as-you-type does not issue a query per keystroke (§9).
    const timer = setTimeout(() => {
      searchTools({ q, filters: selection, sort, page })
        .then((next) => !cancelled && (setResults(next), setError(null)))
        .catch((error: unknown) => !cancelled && setError(searchErrorMessage(error)));
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` is the whole URL query: one dependency that changes exactly when a query should
    // be re-issued, and never when an unrelated re-render happens.
  }, [key]);

  const groups = useMemo(
    () => facetGroups(results?.facets ?? {}, selection),
    [results?.facets, selection],
  );

  const hits = results?.hits ?? [];

  /** Focus follows the roving index rather than the render, so arrow keys move the real focus. */
  useEffect(() => {
    if (focused !== null) resultRefs.current[focused]?.focus();
  }, [focused]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && !isEditableTarget(event.target as HTMLElement | null)) {
        event.preventDefault();
        searchRef.current?.focus();
        setFocused(null);
        return;
      }

      if (event.key === 'Escape' && focused !== null) {
        setFocused(null);
        searchRef.current?.focus();
        return;
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Inside the sidebar's checkboxes and the sort select, arrows mean what they always mean.
      if (isEditableTarget(event.target as HTMLElement | null)) return;

      const next = nextFocusIndex(focused, event.key === 'ArrowDown' ? 'next' : 'previous', hits.length);
      event.preventDefault();
      setFocused(next);
      if (next === null) searchRef.current?.focus();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focused, hits.length]);

  const write = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    mutate(next);
    setParams(next);
    setFocused(null);
  };

  const onToggleFacet = (familyId: string, value: string) =>
    setParams(paramsFromSelection(toggleFacetValue(selection, familyId, value), params));

  const onClear = () => setParams(paramsFromSelection({}, params));

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-5">
      <div className="grid gap-6 lg:grid-cols-[210px_1fr]">
        <FacetSidebar
          groups={groups}
          onToggle={onToggleFacet}
          onClear={onClear}
          hasSelection={Object.keys(selection).length > 0}
        />

        <div className="min-w-0">
          <form
            className="mb-4 flex items-center gap-2.5 rounded-card border border-line-strong bg-surface px-3.5 py-2.5 lg:hidden"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get('q');
              write((next) => {
                next.set('q', typeof value === 'string' ? value : '');
                next.delete('page');
              });
            }}
          >
            <input
              ref={searchRef}
              name="q"
              type="search"
              defaultValue={q}
              aria-label="Search"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </form>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ActiveFilters groups={groups} onToggle={onToggleFacet} />
            {results && (
              <span className="ml-auto text-[11.5px] text-muted">
                <span className="font-mono tabular-nums">{results.total.toLocaleString('en-GB')}</span>{' '}
                tools · <span className="font-mono">{results.processingTimeMs} ms</span>
              </span>
            )}
            <SearchControls
              sort={sort}
              view={view}
              onSort={(next) => write((params) => (next === 'relevance' ? params.delete('sort') : params.set('sort', next)))}
              onView={(next) => write((params) => (next === 'list' ? params.delete('view') : params.set('view', next)))}
            />
          </div>

          {error && <SearchError message={error} />}

          {results && results.total === 0 && !error && <NoResults query={q} />}

          {hits.length > 0 && (
            <ul className={view === 'grid' ? 'grid gap-3 sm:grid-cols-2' : 'space-y-2.5'}>
              {hits.map((tool, index) => (
                <li key={tool.id}>
                  <ResultCard
                    tool={tool}
                    view={view}
                    tabIndex={focused === index || (focused === null && index === 0) ? 0 : -1}
                    ref={(node) => {
                      resultRefs.current[index] = node;
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Verify the whole page by hand**

```bash
mise run web:mock
```

At `http://localhost:5173/search?q=ingress`, confirm every one of these:

1. The sidebar lists only families that have hits, with counts.
2. Ticking a checkbox updates the URL, the results and the active-filter row.
3. An active-filter chip removes its filter when clicked.
4. "Clear all" empties the selection but keeps `q` in the URL.
5. Changing sort and view updates the URL; reloading the page preserves both.
6. Browser back undoes a filter change.
7. `/` focuses the search field; typing `/` **inside** the field inserts a slash instead.
8. `↓` moves focus down the results, `↑` back up, `↑` from the first returns to the search field.
9. `Enter` on a focused result opens it; `Escape` returns focus to the search field.
10. A query with no matches shows the "Nothing matches" card, not a blank page.

- [ ] **Step 3: Run the full suite**

Run: `mise run test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/search.tsx
git commit -m "feat(web): build out the search page with facets, views and keyboard navigation"
```

---

## Task 14: Tool page — score breakdown

**Files:**
- Create: `apps/web/src/components/tool/score-meters.tsx`

- [ ] **Step 1: Write `score-meters.tsx`**

```tsx
import type { ToolDocument } from '@keco/core';
import { Meter } from '../primitives/meter';

/**
 * The four score axes and their weights (§4.4), plus the aggregate and its coverage.
 *
 * Health is magnitude, so this is one hue, more-is-darker, with the number always beside the
 * bar. It is never green/amber/red: §4.3 and §4.4 make "missing ≠ bad" a rule, and painting a
 * repo red because OpenSSF's cron set never scanned it would be exactly the corpus-wide bias
 * they forbid. `quality_coverage` is drawn as a dashed ceiling on the Quality axis and stated
 * in words, because a 0.9 from four signals and a 0.9 from one are not the same claim.
 */
const AXES = [
  { key: 'popularity', label: 'Popularity', weight: 35 },
  { key: 'activity', label: 'Activity', weight: 30 },
  { key: 'adoption', label: 'Adoption', weight: 20 },
  { key: 'quality', label: 'Quality', weight: 15 },
] as const;

export function ScoreMeters({ score }: { score: ToolDocument['score'] }) {
  const coveragePercent = Math.round(score.quality_coverage * 100);

  return (
    <section
      aria-labelledby="health"
      className="rounded-card border border-line bg-surface p-4 shadow-card"
    >
      <h2 id="health" className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
        Health
      </h2>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[32px] font-semibold tracking-tight text-fg tabular-nums">
          {score.total.toFixed(2)}
        </span>
        <span className="text-[11.5px] text-muted">of 1.00</span>
      </div>

      <p className="mb-4 mt-1 text-[11px] leading-relaxed text-faint">
        Quality scored on <strong className="font-semibold text-fg-2">{coveragePercent}%</strong> of
        its signals. Anything a provider never reported is treated as unknown, not as zero.
      </p>

      <dl className="space-y-2.5">
        {AXES.map((axis) => (
          <div key={axis.key}>
            <div className="mb-1 flex items-baseline justify-between text-[11.5px]">
              <dt className="text-fg-2">
                {axis.label} <span className="text-faint">·{axis.weight}%</span>
              </dt>
              <dd className="font-mono tabular-nums text-fg">{score[axis.key].toFixed(2)}</dd>
            </div>
            <Meter
              value={score[axis.key]}
              label={axis.label}
              coverage={axis.key === 'quality' ? score.quality_coverage : undefined}
            />
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `mise run check`
Expected: PASS.

If `score[axis.key]` errors, the `as const` on `AXES` is missing — without it the keys widen to `string` and cannot index `score`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tool/score-meters.tsx
git commit -m "feat(web): show the score breakdown with its coverage ceiling"
```

---

## Task 15: Tool page — install tabs

**Files:**
- Create: `apps/web/src/components/tool/install-tabs.tsx`

- [ ] **Step 1: Write `install-tabs.tsx`**

```tsx
import { useState } from 'react';
import type { ToolDocument } from '@keco/core';
import { formatUtcDate } from '../../lib/dates';
import { CopyButton } from '../primitives/copy-button';

/**
 * One tab per *verified* install method. Nothing here constructs a command: every string comes
 * from the document, where it was written only after being proven against a registry, and each
 * carries the `source_url` that proves it (§6).
 *
 * An empty list renders the honest sentence rather than a plausible guess. Rendering a
 * `brew install` line for a formula that does not exist is the single worst bug this project
 * can ship, because people paste these into a terminal.
 */
export function InstallTabs({ methods }: { methods: ToolDocument['install_methods'] }) {
  const [active, setActive] = useState(0);

  if (methods.length === 0) {
    return (
      <section aria-labelledby="install" className="rounded-card border border-line bg-surface p-4">
        <h2 id="install" className="mb-1.5 text-[15px] font-semibold text-fg">Install</h2>
        <p className="text-[13px] text-muted">
          No install method has been verified against a registry, so none is listed.
        </p>
      </section>
    );
  }

  const method = methods[Math.min(active, methods.length - 1)];

  return (
    <section aria-labelledby="install" className="overflow-hidden rounded-card border border-line bg-surface">
      <h2 id="install" className="sr-only">Install</h2>

      <div role="tablist" aria-label="Install methods" className="flex items-center gap-0.5 border-b border-line px-1">
        {methods.map((entry, index) => (
          <button
            key={entry.method}
            type="button"
            role="tab"
            id={`install-tab-${entry.method}`}
            aria-selected={index === active}
            aria-controls="install-panel"
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const step = event.key === 'ArrowRight' ? 1 : -1;
              setActive((current) => (current + step + methods.length) % methods.length);
            }}
            className={`px-3 py-2 font-mono text-xs transition-colors ${
              index === active
                ? 'border-b-2 border-accent font-medium text-accent-text'
                : 'text-muted hover:text-fg'
            }`}
          >
            {entry.method}
          </button>
        ))}
        <span className="ml-auto pr-2.5 text-[10.5px] text-faint">
          {methods.length} verified against a registry
        </span>
      </div>

      <div role="tabpanel" id="install-panel" aria-labelledby={`install-tab-${method.method}`} className="p-3.5">
        <div className="flex items-center gap-2.5 rounded-control border border-line bg-surface-2 px-3 py-2.5">
          <span aria-hidden="true" className="shrink-0 font-mono text-good">$</span>
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-fg">
            {method.command}
          </code>
          <CopyButton value={method.command} />
        </div>

        <p className="mt-2 text-[11px] text-faint">
          <span aria-hidden="true" className="text-good">✓</span>{' '}
          <a href={method.source_url} rel="noreferrer" className="text-accent-text underline">
            Proof this entry exists
          </a>
          {method.verified_at && <> · checked {formatUtcDate(method.verified_at)}</>}
        </p>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `mise run check`
Expected: PASS.

`InstallMethodEntry` is `{ method, command, source_url, verified_at }` and every field is required — verified against `packages/core/src/schemas.ts:11`. The `{method.verified_at && …}` guard is therefore belt-and-braces rather than a real branch; leave it, because a projector that ever emits a partial entry should degrade to a missing date rather than to "Invalid Date".

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tool/install-tabs.tsx
git commit -m "feat(web): add verified install tabs with their registry proof"
```

---

## Task 16: Tool page — layout, facts, related and the README

**Files:**
- Create: `apps/web/src/components/tool/fact-list.tsx`
- Create: `apps/web/src/components/tool/related-list.tsx`
- Modify: `apps/web/src/routes/tool.tsx`

- [ ] **Step 1: Write `fact-list.tsx`**

```tsx
import type { ToolDocument } from '@keco/core';
import { formatUtcDate } from '../../lib/dates';

/**
 * Repository facts, straight from the document. Dates go through `formatUtcDate`, which exists
 * because a bare toDateString() hydration-mismatches near midnight between the prerender build
 * machine and the reader's browser (§9).
 */
export function FactList({ tool }: { tool: ToolDocument }) {
  const facts: [string, React.ReactNode][] = [
    ['Stars', <span className="font-mono tabular-nums">{tool.stars.toLocaleString('en-GB')}</span>],
    ['Forks', <span className="font-mono tabular-nums">{tool.forks.toLocaleString('en-GB')}</span>],
    ['Language', tool.language ?? 'unknown'],
    ['Licence', tool.license ?? 'none declared'],
    ['Last commit', formatUtcDate(tool.pushed_at)],
  ];

  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-card">
      <dl className="space-y-2 text-[12.5px]">
        {facts.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">{label}</dt>
            <dd className="text-fg-2">{value}</dd>
          </div>
        ))}
      </dl>

      <a
        href={tool.repo_url}
        rel="noreferrer"
        className="mt-3 block border-t border-line pt-2.5 text-[12.5px] text-accent-text"
      >
        ↗ Source on GitHub
      </a>
    </section>
  );
}
```

- [ ] **Step 2: Write `related-list.tsx`**

```tsx
import { Link } from 'react-router';
import type { ToolDocument } from '@keco/core';

export function RelatedList({ tools }: { tools: ToolDocument[] }) {
  if (tools.length === 0) return null;

  return (
    <section aria-labelledby="related" className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="related" className="mb-2.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
        Related
      </h2>
      <ul className="space-y-2.5">
        {tools.map((tool) => (
          <li key={tool.id}>
            <Link to={`/tools/${tool.full_name}`} className="block">
              <span className="text-[12.5px] font-medium text-accent-text">{tool.name}</span>
              <span className="block text-[11px] text-faint">
                {tool.owner} · <span className="font-mono tabular-nums">{tool.score.total.toFixed(2)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 3: Restyle `apps/web/src/routes/tool.tsx`**

Keep every existing comment, all four `useState` hooks, both `useEffect` bodies, and the `bootstrapToolFor` call **exactly as they are** — they encode the prerender/hydration contract. Replace only the imports and the returned JSX.

Add these imports:

```tsx
import { Chip } from '../components/primitives/chip';
import { StatusPill } from '../components/primitives/status-pill';
import { FactList } from '../components/tool/fact-list';
import { InstallTabs } from '../components/tool/install-tabs';
import { RelatedList } from '../components/tool/related-list';
import { ScoreMeters } from '../components/tool/score-meters';
```

Remove the now-unused `formatUtcDate` import if `tool.tsx` no longer calls it directly.

Replace the loading branch and the final `return`:

```tsx
  if (loading) {
    return (
      <main aria-busy="true" className="mx-auto max-w-[1200px] px-4 py-16 text-sm text-muted">
        Loading {fullName}…
      </main>
    );
  }
  if (!tool) return <NotFoundPage />;

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-6">
      <div className="grid gap-8 lg:grid-cols-[1fr_250px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h1 className="text-[25px] font-bold tracking-tight text-fg">{tool.name}</h1>
            <span className="font-mono text-[12.5px] text-faint">{tool.full_name}</span>
            {tool.archived && <StatusPill tone="warn">Archived</StatusPill>}
          </div>

          <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-fg-2">{tool.summary}</p>

          <div className="mt-3.5 flex flex-wrap gap-1.5">
            <Chip label={`kind: ${tool.kind}`} />
            {tool.domains.map((domain) => (
              <Chip key={domain} label={domain} />
            ))}
            <Chip label={tool.runtime} />
            <Chip label={tool.maturity} />
          </div>

          <div className="mt-5">
            <InstallTabs methods={tool.install_methods} />
          </div>

          <section aria-labelledby="readme" className="mt-5">
            <h2 id="readme" className="mb-2 text-[15px] font-semibold text-fg">README</h2>
            <div className="rounded-card border border-line bg-surface p-4 shadow-card">
              {readmeHtml === null ? (
                // The excerpt is in the document, so it is in the prerendered HTML too — this is
                // the indexable prose on the page until the full README arrives.
                <p className="text-[13px] leading-relaxed text-fg-2">{tool.readme_excerpt}</p>
              ) : (
                // Sanitised by apps/api with rehype-sanitize before it ever reached the browser
                // (§9, §14). Never do this to raw markdown. `prose-keco` is not optional:
                // Tailwind's preflight strips every element default, so without it this
                // corpus-derived documentation renders flat.
                <div
                  className="prose prose-sm prose-keco dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: readmeHtml }}
                />
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-3">
          <ScoreMeters score={tool.score} />
          <FactList tool={tool} />
          <RelatedList tools={related} />
          <p className="text-[10.5px] leading-relaxed text-faint">
            Data from GitHub, indexed {new Date(tool.indexed_at).toISOString()}.
          </p>
        </aside>
      </div>
    </main>
  );
```

- [ ] **Step 4: Verify, including the README trap §14 names**

```bash
mise run web:mock
```

At a tool page, confirm: install tabs switch with arrow keys and copy the command; the score card shows four meters and the coverage sentence; the README renders with real headings, lists and code blocks (**not** flat text — if it is flat, `prose-keco` is missing); and the whole page inverts correctly with the theme toggle.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tool apps/web/src/routes/tool.tsx
git commit -m "feat(web): build out the tool page with install tabs, health and a styled README"
```

---

## Task 17: 404

**Files:**
- Modify: `apps/web/src/routes/not-found.tsx`

- [ ] **Step 1: Rewrite it**

```tsx
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="mx-auto max-w-[1200px] px-4 py-24 text-center">
      <h1 className="text-[25px] font-bold tracking-tight text-fg">Not found</h1>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
        That page does not exist. Try <Link to="/" className="text-accent-text">the home page</Link>{' '}
        or <Link to="/search" className="text-accent-text">search the ecosystem</Link>.
      </p>
    </main>
  );
}
```

- [ ] **Step 2: Verify**

Visit `http://localhost:5173/nope`. Expected: the styled 404 inside the shell.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/not-found.tsx
git commit -m "feat(web): style the not-found page"
```

---

## Task 18: Documentation

**Files:**
- Modify: `apps/web/README.md`
- Modify: `AGENTS.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Add a theming section to `apps/web/README.md`**

```markdown
## Theming

Tokens live in `src/styles/theme.css` in two layers. Layer one defines semantic custom
properties (`--keco-*`) three times: light on `:root`, dark under `prefers-color-scheme`, and
dark again on `[data-theme='dark']` for readers who used the toggle. Layer two is
`@theme inline`, which makes Tailwind emit utilities that *reference* those variables instead
of baking a hex — drop `inline` and the theme toggle silently stops working.

The attribute is stamped before first paint by an inline script in `index.html`, marked
`keco-theme-bootstrap`. `prerender/html.ts` asserts that marker is still in the built shell and
fails the build if it is not: a prerendered page has real content, so losing the script means
1000 static pages that flash the wrong theme.

**Never build a class name dynamically.** Tailwind v4 finds classes by scanning source text, so
`` `bg-${tone}` `` produces a class that is never generated. Where a value maps to a style, the
map holds complete class strings — see `STEPS` in `components/primitives/meter.tsx`.
```

- [ ] **Step 2: Record the contract change in `AGENTS.md` §9**

Add after the paragraph beginning "**Search is browser → Meilisearch, directly.**":

```markdown
**Theme.** Light by default, dark by `prefers-color-scheme`, and overridable by a header toggle
that persists to `localStorage`. An inline, blocking script in `index.html` — marked
`keco-theme-bootstrap` — stamps `data-theme` on `<html>` before first paint, because a
prerendered page has real content to flash. That script is part of the prerender contract:
`prerender/html.ts` asserts the built shell still contains it, alongside its existing
assertions on `<title>`, the meta description and `<div id="root">`. Design tokens live in
`apps/web/src/styles/theme.css` and reach Tailwind through `@theme inline`; a token defined any
other way cannot follow the theme.
```

- [ ] **Step 3: Update `ROADMAP.md`**

Replace the two 🚧 read-side bullets with:

```markdown
- ✅ **Search** — URL-synced state, browser-direct Meilisearch queries, facet sidebar built from
  the distribution the search query already returns, list/grid toggle, sort, active-filter row
  and keyboard navigation (`/`, arrows, enter, escape).
- ✅ **Tool page** — prerendered for the top 1000 by score, README rendered from the cache by
  `apps/api` (sanitised, relative URLs rewritten, badge paragraph stripped, Shiki), install tabs
  with registry proof, and a score breakdown showing `quality_coverage`. Still to do: adopters
  with an `evidence_url`, which need the projector to emit them first.
- ✅ **Theme** — light/dark design system applied to all four routes; see
  `docs/superpowers/specs/2026-08-24-portal-theme-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/README.md AGENTS.md ROADMAP.md
git commit -m "docs: record the theme mechanism and the new shell contract"
```

---

## Task 19: Full verification

- [ ] **Step 1: Run the gate**

Run: `mise run ci`
Expected: PASS — check, lint, test, taxonomy:check.

Lint will flag unused imports left behind in `tool.tsx` and `search.tsx`. Remove them rather than suppressing.

- [ ] **Step 2: Verify the production build, including the mock scan**

Run: `mise run build`
Expected: completes through `vite build`, `prerender`, `assert:no-mocks` and the API typecheck.

The prerender needs a reachable Meilisearch. If it is not running, `mise run infra:up` first. An empty index is fine — it prerenders zero pages and still writes `sitemap.xml` and `robots.txt`.

- [ ] **Step 3: Prove the theme reached the prerendered output**

```bash
grep -c 'keco-theme-bootstrap' apps/web/dist/index.html
grep -o 'assets/[^"]*\.css' apps/web/dist/index.html | head -1
```

Expected: the first prints `1`; the second prints a hashed CSS path. If a tool page was prerendered, confirm it inherited both:

```bash
find apps/web/dist/prerendered -name '*.html' | head -1 | xargs grep -c 'keco-theme-bootstrap'
```

Expected: `1`. Zero means the prerender assertion is not doing its job.

- [ ] **Step 4: Confirm no secret entered the bundle (§15.5)**

```bash
grep -ro 'VITE_[A-Z_]*' apps/web/dist/assets | sort -u
```

Expected: nothing, or only `VITE_MEILI_SEARCH_KEY`'s *value* inlined — which is a search-only key scoped to `tools` and public by design. Any other `VITE_`-prefixed name is a leak: that prefix is permanent and published.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(web): tidy up after the theme pass"
```

---

## Self-review notes

Checked against the spec:

- **Governing constraint** — prerender stylesheet inheritance verified in Task 19 Step 3; pre-paint script in Task 3; preflight/README handled in Task 2 Step 2 and Task 16 Step 3.
- **Every "In scope" bullet** has a task: tokens (2), themes (2–4), Inter (1–2), shell (9), all four routes (10, 13, 16, 17), facet sidebar (6, 11, 13), active filters (11), list/grid + sort (11, 13), keyboard nav (7, 13), install tabs (15), score breakdown (14), related (16), empty states (12), `paramsFromSelection` (5).
- **Out of scope** stays out: no `apps/backoffice`, no adopters section, no analytics.
- **Type consistency** — `FacetGroup`/`FacetOption` (Task 6) are consumed unchanged in Tasks 11 and 13; `ViewMode` and `isViewMode` are defined in Task 11 and imported in Task 13; `Theme`/`applyTheme`/`currentTheme` (Task 4) are used in Task 9; `paramsFromSelection`/`toggleFacetValue` (Task 5) are used in Task 13; `healthClass` is exported from `meter.tsx` for reuse though only `Meter` consumes it today.
- **Known deviation from the spec:** the spec put corpus size and `indexed_at` in the footer. The footer cannot fetch — `renderToString` does not run effects, so all 1000 prerendered pages would ship an empty footer. The freshness line moved to the home hero, where `browseFacets()` already runs, and the tool page keeps its own `indexed_at` line. Task 10 implements it that way.
