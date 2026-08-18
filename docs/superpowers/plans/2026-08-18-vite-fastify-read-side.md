# Read Side on Vite + Fastify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Next.js read side with a Vite + React static SPA (`apps/web`) and a Fastify backend (`apps/api`) that serves both the JSON routes and the built SPA, reconciling the repository with AGENTS.md §7 and §9–§12.

**Architecture:** Two deployables, one Node process. `apps/web` builds to `dist/`; a build-time prerender emits real HTML per tool page plus `sitemap.xml`, `robots.txt` and a manifest; `apps/api` serves `/api/*` and the SPA, choosing a prerendered file over `index.html` when the manifest lists the path. The portal queries Meilisearch directly with a search-only key; the API queries it through `@keco/query`. Two pure modules move down into `@keco/core` so a browser bundle can use the taxonomy and the filter algebra without importing a write-side package.

**Tech Stack:** Vite 8, React 19, react-router 8, Fastify 5 (`@fastify/static`, `@fastify/cors`, `@fastify/cookie`, `@fastify/rate-limit`), unified/remark/rehype + `rehype-sanitize` + Shiki 4, zod 4, vitest 4, TypeScript 5.9, pnpm workspaces, mise.

**Spec:** `docs/superpowers/specs/2026-08-18-vite-fastify-read-side-design.md`

---

## File Structure

### `packages/core` — modified

| File | Responsibility |
|---|---|
| `src/taxonomy-source.ts` (new) | Node: locate and read `taxonomy.yaml` off disk. The only `node:fs` code in the package. |
| `src/taxonomy-source.browser.ts` (new) | Browser: return the YAML inlined by Vite's `?raw`. Same exported names. |
| `src/globals.d.ts` (new) | Ambient declaration for `*.yaml?raw`. |
| `src/taxonomy.ts` (modified) | Unchanged responsibility — parse, validate, freeze, expose accessors. Byte-loading delegated. |
| `src/read.ts` (new) | The read-side algebra: filters, facets, URL-param selection, sort specs, family→attribute mapping, index name. Pure. |
| `src/read.test.ts` (new) | Moved from `packages/query/src/filters.test.ts`, extended for the moved symbols. |
| `src/index.ts` (modified) | Re-export `./read`. |
| `package.json` (modified) | `browser` field remapping the source module; `./read` subpath. |

### `packages/search`, `packages/query` — modified

| File | Change |
|---|---|
| `packages/search/src/settings.ts` | Import `familyAttribute` and `TOOLS_INDEX` from `@keco/core`; re-export `TOOLS_ALIAS`. Stops defining them. |
| `packages/query/src/filters.ts` | Deleted — moved to `@keco/core`. |
| `packages/query/src/filters.test.ts` | Deleted — moved to `@keco/core`. |
| `packages/query/src/index.ts` | Imports the algebra from `@keco/core`; uses `sortSpec`; drops the `@keco/search` import. |
| `packages/query/package.json` | Drops the `@keco/search` dependency. |

### `apps/api` — new

| File | Responsibility |
|---|---|
| `src/index.ts` | Process entry: load env, build, listen, wire shutdown. |
| `src/server.ts` | `build()` → a configured Fastify instance. No `listen`, so tests use `inject`. |
| `src/env.ts` | zod-validated configuration, loaded once, fails loudly. |
| `src/ports.ts` | The `Retrieval` and `ReadOnlyCache` seams, and their live implementations. Defined here, not in `server.ts`, so routes never import from the module that imports them. |
| `src/session.ts` | The admin cookie name and `hasAdminSession`, shared by the admin and command routes. |
| `src/auth.ts` | scrypt password hashing/verification and constant-time token comparison. |
| `src/bin/hash-password.ts` | CLI to produce an `ADMIN_PASSWORD_HASH`. |
| `src/plugins/static.ts` | `@fastify/static` + the manifest loader + the not-found handler. |
| `src/routes/v1.ts` | `/api/v1/search`, `/api/v1/tools/:owner/:repo`. CORS + rate limit. |
| `src/routes/readme.ts` | `/api/readme/:owner/:repo` — cache read by key, rendered HTML. |
| `src/routes/admin.ts` | `/api/admin/login`, `/logout`, `/session`. |
| `src/routes/commands.ts` | `/api/commands/:command` — enqueue only. |
| `src/routes/mcp.ts` | Tool descriptions; still 501. |
| `src/routes/chat.ts` | 501 (v2). |
| `src/readme/render.ts` | markdown → sanitised HTML. Pure, no I/O. |
| `src/readme/rewrite-urls.ts` | hast plugin: relative `src`/`href` → absolute. |
| `src/readme/strip-badges.ts` | hast plugin: drop the leading badge-only paragraph. |

### `apps/web` — rewritten

| File | Responsibility |
|---|---|
| `index.html`, `vite.config.ts` | The shell and the build/dev config (including the `/api` dev proxy). |
| `src/main.tsx` | Client entry: hydrate over prerendered markup, or mount fresh. |
| `src/app.tsx` | The route tree. Imported by both `main.tsx` and the prerender. |
| `src/routes/{home,search,tool,not-found}.tsx` | One route each. |
| `src/lib/meili.ts` | Lazy browser Meilisearch client. |
| `src/lib/search.ts` | The portal's retrieval adapter over `@keco/core`'s algebra. |
| `src/lib/topics.ts` (+ test) | Moved from the Next app; facet distribution → chip rows. |
| `src/lib/bootstrap.ts` | Typed access to prerendered page data. |
| `prerender/index.ts` | The build step: query, render, write. |
| `prerender/html.ts` (+ test) | Pure HTML/XML assembly. |

---

## Task 1: Isomorphic taxonomy loading

Splits byte-loading out of `packages/core/src/taxonomy.ts` so a browser bundle can import `@keco/core` without pulling in `node:fs`. Parsing, zod validation and freezing stay exactly where they are, so both environments validate identically.

**Files:**
- Create: `packages/core/src/taxonomy-source.ts`
- Create: `packages/core/src/taxonomy-source.browser.ts`
- Create: `packages/core/src/globals.d.ts`
- Modify: `packages/core/src/taxonomy.ts:1-60` (the fs/path imports, `taxonomyPath`, `readTaxonomyFile`, and the `FILE` construction)
- Modify: `packages/core/src/taxonomy.test.ts:20` (import site) and `:111-115` (the not-found test)
- Modify: `packages/core/package.json`

- [ ] **Step 1: Write the failing test**

Replace the whole `it('throws an actionable error reading a deliberately absent path', ...)` block in `packages/core/src/taxonomy.test.ts` (lines 111–115) with this, and add the new import line:

```typescript
  it('throws an actionable error reading a deliberately absent path', () => {
    const missing = '/deliberately/absent/path/taxonomy.yaml';
    expect(() => readTaxonomyFile(missing)).toThrow(/^taxonomy: /);
    expect(() => readTaxonomyFile(missing)).toThrow(missing);
  });

  it('loads the same bytes through the source module the browser build uses', () => {
    // The browser variant returns a Vite-inlined string instead of reading the disk, so the
    // only thing that can drift between the two builds is the bytes. Pin them here: the
    // parse, the zod validation and the freezing are shared code either way.
    expect(readTaxonomySource()).toBe(readTaxonomyFile());
    expect(readTaxonomySource()).toContain('families:');
  });
```

At the top of the file, remove `readTaxonomyFile` from the `./taxonomy` import list and add:

```typescript
import { readTaxonomyFile, readTaxonomySource } from './taxonomy-source';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/taxonomy.test.ts`
Expected: FAIL — `Failed to resolve import "./taxonomy-source"`.

- [ ] **Step 3: Create the Node source module**

Create `packages/core/src/taxonomy-source.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Byte-loading for the taxonomy file, and the only `node:*` code in @keco/core.
 *
 * It lives in its own module so that `package.json`'s `browser` field can swap it for
 * `taxonomy-source.browser.ts` in a bundle (AGENTS.md §7: a frontend importing `node:*` is a
 * build-time bug). Everything that gives the taxonomy meaning — the YAML parse, the zod
 * validation, the freezing, the accessors — stays in `taxonomy.ts` and is shared by both
 * builds, so the two environments cannot disagree about what the vocabulary is.
 */
const FILENAME = 'taxonomy.yaml';

/**
 * Resolves `packages/core/taxonomy.yaml` relative to this module's own location. Not
 * exported: callers get `readTaxonomySource()`, which is the part that has a browser
 * counterpart.
 */
function taxonomyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', FILENAME);
}

/**
 * Reads the taxonomy file at `path` (default: `taxonomyPath()`). The `path` parameter exists
 * so the not-found branch is reachable from a test without a filesystem mocking layer — by
 * the time any other test runs, module load has already succeeded once, so that branch would
 * otherwise be untestable.
 *
 * Node-only. The browser module has no counterpart for it, because there is no path to miss.
 */
export function readTaxonomyFile(path: string = taxonomyPath()): string {
  if (!existsSync(path)) {
    throw new Error(`taxonomy: ${FILENAME} not found. Looked in:\n  ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/** The one function `taxonomy.ts` calls, and the one the browser module also provides. */
export const readTaxonomySource = (): string => readTaxonomyFile();
```

- [ ] **Step 4: Create the browser source module and its ambient type**

Create `packages/core/src/taxonomy-source.browser.ts`:

```typescript
// `?raw` is a Vite primitive: the YAML is inlined into the bundle as a string at build time.
// No YAML loader plugin is involved, and the file stays the single source of truth — this
// module only supplies the bytes that `taxonomy.ts` then parses and validates (AGENTS.md §6).
import raw from '../taxonomy.yaml?raw';

export const readTaxonomySource = (): string => raw;
```

Create `packages/core/src/globals.d.ts`:

```typescript
/** Vite's `?raw` suffix, so `taxonomy-source.browser.ts` typechecks under the workspace tsc. */
declare module '*.yaml?raw' {
  const contents: string;
  export default contents;
}
```

- [ ] **Step 5: Point `taxonomy.ts` at the source module**

In `packages/core/src/taxonomy.ts`, delete the three `node:` imports at the top and the whole
`FILENAME` / `taxonomyPath` / `readTaxonomyFile` block (lines 1–3 and 30–60), then add this
import alongside the existing ones:

```typescript
import { readTaxonomySource } from './taxonomy-source';
```

Change the `FILE` construction (was line 86) to:

```typescript
const FILE = deepFreezeTaxonomy(parseTaxonomy(readTaxonomySource()));
```

Replace the stale paragraph in the module doc comment that begins "Verified: plain Node ESM
(workers) and vitest…" — it described the bundler path as unverified. The module doc comment
now reads, in place of that paragraph:

```typescript
/**
 * The closed vocabulary (AGENTS.md §6), loaded from `packages/core/taxonomy.yaml`.
 *
 * Two axes, never one: `kind` is what the artifact *is*, `domains` is what it solves.
 * Cilium is a controller AND networking; a flat category list cannot say that.
 *
 * The file is read once at module load and validated in full. A malformed taxonomy takes
 * every worker, the API and the portal bundle down immediately rather than letting them
 * classify into a vocabulary that does not exist.
 *
 * Where the bytes come from is `taxonomy-source.ts`'s problem: Node reads the file off disk,
 * and a Vite bundle gets it inlined by the `browser` field's swap to
 * `taxonomy-source.browser.ts`. Parsing, validation and freezing are shared, so the two
 * builds cannot disagree about the vocabulary.
 *
 * Because the vocabulary is data, `Kind` and friends are `string`, not literal unions. The
 * safety net that replaces compile-time checking is packages/analyze/src/rules/pinning.test.ts,
 * which asserts every value any rule can emit exists in this file.
 *
 * Import cost: this module reads the source, parses YAML and runs full zod validation
 * synchronously at import time. `index.ts` re-exports it and `schemas.ts` imports value
 * bindings from it, so importing *anything* from `@keco/core` pays that cost — including a
 * browser bundle that only wanted a type. The cost is sub-millisecond; the `@keco/core/events`
 * subpath export skips it for consumers that have no need for the taxonomy.
 */
```

- [ ] **Step 6: Add the `browser` field**

In `packages/core/package.json`, add a `browser` key immediately after `"exports"`:

```json
  "browser": {
    "./src/taxonomy-source.ts": "./src/taxonomy-source.browser.ts"
  },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core && pnpm -F @keco/core check`
Expected: PASS. `taxonomy.test.ts` reports all its cases green, including the two touched ones, and `tsc --noEmit` prints nothing.

- [ ] **Step 8: Verify nothing else broke**

Run: `pnpm vitest run && pnpm -r --parallel check`
Expected: PASS across every package. `readTaxonomyFile` was only ever imported by `taxonomy.ts` and its test, so nothing else moves.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/taxonomy-source.ts packages/core/src/taxonomy-source.browser.ts \
        packages/core/src/globals.d.ts packages/core/src/taxonomy.ts \
        packages/core/src/taxonomy.test.ts packages/core/package.json
git commit -m "refactor(core): split taxonomy byte-loading so a bundle can import it

node:fs moves to taxonomy-source.ts, with a browser counterpart that Vite's ?raw
inlines, swapped by package.json's browser field. Parse, validation and freezing
stay shared, so the two builds cannot disagree about the vocabulary (AGENTS.md §7)."
```

---

## Task 2: Move the read-side algebra into `@keco/core`

`buildFilters`, `selectionFromParams`, `defaultFacets`, `familyAttribute` and the sort specs are pure functions over the taxonomy. They currently live in `@keco/query` and `@keco/search`, which §7 bars a browser bundle from importing. Moving them into `@keco/core` lets the portal and the API share one implementation without touching §7.

**Files:**
- Create: `packages/core/src/read.ts`
- Create: `packages/core/src/read.test.ts`
- Delete: `packages/query/src/filters.ts`, `packages/query/src/filters.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`
- Modify: `packages/search/src/settings.ts:1-5,26-33`
- Modify: `packages/query/src/index.ts:1-4,29-31,60-70,140-146`, `packages/query/package.json`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/read.test.ts` — the whole of the old `packages/query/src/filters.test.ts`, plus cases for the two symbols that moved in from `@keco/search` and for the new sort helpers:

```typescript
import { describe, expect, it } from 'vitest';
import {
  TOOLS_INDEX,
  buildFilters,
  defaultFacets,
  familyAttribute,
  isSortKey,
  paramForFamily,
  selectionFromParams,
  sortSpec,
} from './read';

describe('buildFilters', () => {
  it('always excludes archived tools and gates on relevance', () => {
    expect(buildFilters({})).toEqual(['archived = false', 'k8s_relevance >= 0.4']);
  });

  it('includes archived tools when asked', () => {
    expect(buildFilters({ includeArchived: true })).toEqual(['k8s_relevance >= 0.4']);
  });

  it('honours a custom relevance floor', () => {
    expect(buildFilters({ minRelevance: 0 })).toContain('k8s_relevance >= 0');
  });

  it('emits one IN clause per selected family', () => {
    const filters = buildFilters({ filters: { kind: ['cli'], domains: ['security', 'policy'] } });
    expect(filters).toContain('kind IN ["cli"]');
    expect(filters).toContain('domains IN ["security", "policy"]');
  });

  it('nests the install method attribute', () => {
    expect(buildFilters({ filters: { install_methods: ['krew'] } })).toContain(
      'install_methods.method IN ["krew"]',
    );
  });

  it('ignores an empty selection', () => {
    expect(buildFilters({ filters: { kind: [] } })).not.toContainEqual(expect.stringContaining('kind IN'));
  });

  it('ignores a family that is not in the taxonomy', () => {
    expect(buildFilters({ filters: { nonsense: ['x'] } })).not.toContainEqual(
      expect.stringContaining('nonsense'),
    );
  });

  it('filters on language and license, which are not families', () => {
    const filters = buildFilters({ language: ['Go'], license: ['Apache-2.0'] });
    expect(filters).toContain('language IN ["Go"]');
    expect(filters).toContain('license IN ["Apache-2.0"]');
  });
});

describe('defaultFacets', () => {
  it('asks for every facetable family', () => {
    expect(defaultFacets()).toContain('kind');
    expect(defaultFacets()).toContain('install_methods.method');
    expect(defaultFacets()).toContain('governance');
  });
});

describe('familyAttribute', () => {
  it('nests install_methods, which is an array of objects', () => {
    expect(familyAttribute('install_methods')).toBe('install_methods.method');
  });

  it('leaves every other family as its own attribute', () => {
    expect(familyAttribute('kind')).toBe('kind');
    expect(familyAttribute('governance')).toBe('governance');
  });
});

describe('selectionFromParams', () => {
  it('reads each family from its declared URL parameter', () => {
    const selection = selectionFromParams({ domain: 'security,policy', kind: 'cli', install: 'krew' });
    expect(selection).toEqual({ domains: ['security', 'policy'], kind: ['cli'], install_methods: ['krew'] });
  });

  it('accepts repeated parameters as arrays', () => {
    expect(selectionFromParams({ domain: ['security', 'policy'] })).toEqual({
      domains: ['security', 'policy'],
    });
  });

  it('drops values that are not in the taxonomy', () => {
    expect(selectionFromParams({ kind: 'cli,wasm-module' })).toEqual({ kind: ['cli'] });
  });

  it('drops unknown parameters and empty values', () => {
    expect(selectionFromParams({ q: 'ingress', domain: '', nope: 'x' })).toEqual({});
  });

  it('rejects a value that belongs to a different family', () => {
    expect(selectionFromParams({ kind: 'security' })).toEqual({});
  });

  it('splits a single repeated URLSearchParams key with comma-joined values', () => {
    const params = new URLSearchParams('domain=security,policy');
    expect(selectionFromParams(params)).toEqual({ domains: ['security', 'policy'] });
  });

  it('reads two repetitions of the same URLSearchParams key', () => {
    const params = new URLSearchParams();
    params.append('domain', 'security');
    params.append('domain', 'policy');
    expect(selectionFromParams(params)).toEqual({ domains: ['security', 'policy'] });
  });
});

describe('paramForFamily', () => {
  it('returns the family’s declared URL parameter', () => {
    expect(paramForFamily('domains')).toBe('domain');
    expect(paramForFamily('install_methods')).toBe('install');
  });
});

describe('sortSpec', () => {
  it('defaults to relevance, which is an empty sort', () => {
    expect(sortSpec()).toEqual([]);
    expect(sortSpec('relevance')).toEqual([]);
  });

  it('maps each key to a Meilisearch sort expression', () => {
    expect(sortSpec('stars')).toEqual(['stars:desc']);
    expect(sortSpec('score')).toEqual(['score.total:desc']);
    expect(sortSpec('momentum')).toEqual(['score.momentum:desc']);
    expect(sortSpec('recent')).toEqual(['pushed_at:desc']);
  });
});

describe('isSortKey', () => {
  it('accepts the five keys and rejects anything else', () => {
    // This is what stops a hand-edited ?sort= reaching Meilisearch as an unknown expression.
    expect(isSortKey('momentum')).toBe(true);
    expect(isSortKey('stars:desc')).toBe(false);
    expect(isSortKey('')).toBe(false);
  });
});

describe('TOOLS_INDEX', () => {
  it('is the public alias both the portal and the API read', () => {
    expect(TOOLS_INDEX).toBe('tools');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/read.test.ts`
Expected: FAIL — `Failed to resolve import "./read"`.

- [ ] **Step 3: Create `packages/core/src/read.ts`**

```typescript
import { TAXONOMY, facetableFamilies, family, isValue } from './taxonomy';

/**
 * The read-side algebra (AGENTS.md §5): pure Meilisearch filter and facet construction, plus
 * the URL-parameter mapping. No client, no I/O — which is what makes it testable, and what
 * lets it live in @keco/core where a browser bundle can reach it.
 *
 * It is here rather than in @keco/query because §9 has the portal querying Meilisearch
 * directly with the search-only key, and §7 bars a browser bundle from importing @keco/query
 * or @keco/search. The portal and the API therefore share one *algebra* even though they hold
 * different clients — and the algebra is the part that can silently drift.
 *
 * Everything loops over the taxonomy rather than naming families, so adding a family is a YAML
 * edit plus a rebuild and nothing here changes.
 */

/** The public search corpus. An alias onto `tools_<ts>` (§5). */
export const TOOLS_INDEX = 'tools';

/**
 * One filterable attribute per taxonomy family, derived from the file so that adding a family
 * is a YAML edit — never an edit here that someone forgets (§5, §6). `install_methods` is an
 * array of objects, so it filters on the nested `.method`.
 */
export const familyAttribute = (familyId: string): string =>
  familyId === 'install_methods' ? 'install_methods.method' : familyId;

/** family id → selected value ids. */
export type FacetSelection = Record<string, string[]>;

export type FilterParams = {
  filters?: FacetSelection;
  /** Repository facts, not taxonomy families — open vocabularies that cannot be declared. */
  language?: string[];
  license?: string[];
  includeArchived?: boolean;
  /** Courses, blogs and dotfiles are demoted at projection; filtered out here (§14). */
  minRelevance?: number;
};

const inClause = (attribute: string, values: string[]) =>
  `${attribute} IN [${values.map((value) => `"${value}"`).join(', ')}]`;

export function buildFilters(params: FilterParams): string[] {
  const filters: string[] = [];

  for (const taxonomyFamily of TAXONOMY) {
    const selected = params.filters?.[taxonomyFamily.id];
    if (selected?.length) filters.push(inClause(familyAttribute(taxonomyFamily.id), selected));
  }

  if (params.language?.length) filters.push(inClause('language', params.language));
  if (params.license?.length) filters.push(inClause('license', params.license));

  if (!params.includeArchived) filters.push('archived = false');
  filters.push(`k8s_relevance >= ${params.minRelevance ?? 0.4}`);

  return filters;
}

/** Every facet distribution the home page and the search sidebar need, in one query. */
export const defaultFacets = (): string[] => facetableFamilies().map(familyAttribute);

type RawParams = Record<string, string | string[] | undefined>;

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : value.split(',');

/**
 * Reads a URL query object into a selection, using each family's declared `param` and
 * dropping anything not in the vocabulary — a hand-edited URL must not reach Meilisearch as a
 * filter on a value that cannot exist.
 *
 * Accepts either a plain object or a `URLSearchParams`: the portal has the second (from
 * `useSearchParams`), the REST route has the second too, and both must read facets
 * identically (§11).
 */
export function selectionFromParams(params: RawParams | URLSearchParams): FacetSelection {
  const read = (key: string): string | string[] | undefined =>
    params instanceof URLSearchParams ? params.getAll(key) : params[key];

  const selection: FacetSelection = {};
  for (const taxonomyFamily of TAXONOMY) {
    const values = asList(read(taxonomyFamily.param))
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value !== '' && isValue(taxonomyFamily.id, value));
    if (values.length) selection[taxonomyFamily.id] = values;
  }
  return selection;
}

/** The URL parameter a family is selected by — for building links. */
export const paramForFamily = (familyId: string): string => family(familyId).param;

/**
 * The sort orders the read side offers. Kept here, not in each caller, so the portal's
 * `?sort=` and the REST API's `?sort=` cannot mean different things.
 */
export type SortKey = 'relevance' | 'stars' | 'score' | 'momentum' | 'recent';

const SORTS: Record<SortKey, string[]> = {
  relevance: [],
  stars: ['stars:desc'],
  score: ['score.total:desc'],
  momentum: ['score.momentum:desc'],
  recent: ['pushed_at:desc'],
};

export const sortSpec = (sort: SortKey = 'relevance'): string[] => SORTS[sort];

/** Narrows untrusted input — a `?sort=` value — before it reaches Meilisearch. */
export const isSortKey = (value: string): value is SortKey => Object.hasOwn(SORTS, value);
```

- [ ] **Step 4: Export it from the package**

In `packages/core/src/index.ts`, add the re-export after the `./taxonomy-schema` line:

```typescript
export * from './read';
```

In `packages/core/package.json`, add a `./read` subpath to `exports`, after `"./taxonomy"`:

```json
    "./read": "./src/read.ts",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/read.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 6: Delete the old copies and rewire `@keco/search`**

```bash
git rm packages/query/src/filters.ts packages/query/src/filters.test.ts
```

In `packages/search/src/settings.ts`, change the import on line 1 and delete the local
definitions of `TOOLS_ALIAS` (line 5) and `familyAttribute` (lines 26–33), replacing them with
re-exports:

```typescript
import { TAXONOMY, TOOLS_INDEX, familyAttribute } from '@keco/core';
import type { Settings } from 'meilisearch';

/**
 * The public search corpus. `tools` is an alias onto `tools_<ts>` (AGENTS.md §5).
 *
 * The name and the family→attribute mapping are defined in @keco/core, because the portal
 * needs both and §7 bars a browser bundle from importing this package. Re-exported here so
 * every existing caller keeps its import.
 */
export const TOOLS_ALIAS = TOOLS_INDEX;
export { familyAttribute };

export const REPOS_STATE_INDEX = 'repos_state';
export const TRACES_INDEX = 'traces';
```

Everything from `toolsIndexName` down is unchanged; the `NON_TAXONOMY_FILTERABLE` block and its
comment stay exactly where they are, and `TOOLS_SETTINGS` still calls `familyAttribute`.

- [ ] **Step 7: Rewire `@keco/query`**

In `packages/query/src/index.ts`, replace the first four lines with:

```typescript
import {
  TOOLS_INDEX,
  buildFilters,
  defaultFacets,
  fromDocumentId,
  isSortKey,
  sortSpec,
  toDocumentId,
  type FacetSelection,
  type SortKey,
  type ToolDocument,
} from '@keco/core';
import { Meilisearch } from 'meilisearch';
```

Change the `index` helper (was line 31) to use the moved constant:

```typescript
const index = (client: QueryClient) => client.meili.index<ToolDocument>(client.index ?? TOOLS_INDEX);
```

Change `SearchParams['sort']` to reuse the shared union, and delete the local `SORTS` record:

```typescript
  sort?: SortKey;
```

Change the `searchTools` body's `sort:` line to:

```typescript
    sort: sortSpec(params.sort),
```

Replace the two export lines at the bottom of the file (the `./filters` re-export and the
`FacetSelection` type export) with:

```typescript
export { fromDocumentId, toDocumentId };
export {
  buildFilters,
  defaultFacets,
  familyAttribute,
  isSortKey,
  paramForFamily,
  selectionFromParams,
  sortSpec,
} from '@keco/core';
export type { FacetSelection, SortKey, ToolDocument };
```

Finally, in `createQueryClient`, drop the Next-era environment fallbacks — this client is
server-side only now (§12):

```typescript
export function createQueryClient(env: NodeJS.ProcessEnv = process.env): QueryClient {
  return {
    meili: new Meilisearch({
      host: env.MEILI_HOST || 'http://localhost:7700',
      // Server-side only: apps/api holds the master key, and no bundler ever sees this file.
      // The browser has its own client with a search-only key (§9, §12) — Vite inlines only
      // `VITE_`-prefixed variables, and none of them are read here.
      //
      // `||` and not `??`: an unset variable in a .env file is an empty string, not
      // undefined, and nullish coalescing would hand Meilisearch an empty key.
      apiKey: env.MEILI_MASTER_KEY,
    }),
  };
}
```

In `packages/query/package.json`, delete the `"@keco/search": "workspace:*"` dependency line —
the only symbol it supplied was `TOOLS_ALIAS`, which now comes from `@keco/core`.

- [ ] **Step 8: Run the full suite to verify nothing regressed**

Run: `pnpm vitest run && pnpm -r --parallel check && pnpm eslint .`
Expected: PASS. `packages/search/src/settings.test.ts` still imports `familyAttribute` from
`./settings` and passes on the re-export; `apps/web` will still typecheck because
`@keco/query` re-exports every name it exported before.

- [ ] **Step 9: Commit**

```bash
git add -A packages/core packages/query packages/search
git commit -m "refactor(core): move the read-side filter algebra into @keco/core

buildFilters, selectionFromParams, defaultFacets, familyAttribute, the sort specs
and the tools index name are pure taxonomy functions. §9 has the portal querying
Meilisearch directly and §7 bars a browser bundle from @keco/query and
@keco/search, so they move to where both sides can share them. @keco/query and
@keco/search re-export every name they exported before; @keco/query no longer
depends on @keco/search.

Adds isSortKey so an untrusted ?sort= is narrowed rather than cast."
```

---

## Task 3: Scaffold `apps/api` — package, env, server

The Fastify skeleton, built so that `build()` returns an instance instead of listening. Every later task tests through `fastify.inject`, so no test in this plan opens a socket.

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`
- Create: `apps/api/src/env.ts`, `apps/api/src/env.test.ts`
- Create: `apps/api/src/server.ts`, `apps/api/src/server.test.ts`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/query.ts`, `apps/api/src/cache.ts`

- [ ] **Step 1: Create the package manifest and tsconfig**

Create `apps/api/package.json`:

```json
{
  "name": "@keco/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit",
    "dev": "node --import tsx --watch src/index.ts",
    "start": "node --import tsx src/index.ts",
    "admin:hash": "node --import tsx src/bin/hash-password.ts"
  },
  "dependencies": {
    "@fastify/cookie": "^11.1.2",
    "@fastify/cors": "^11.3.0",
    "@fastify/rate-limit": "^11.2.0",
    "@fastify/static": "^10.1.3",
    "@keco/cache": "workspace:*",
    "@keco/core": "workspace:*",
    "@keco/query": "workspace:*",
    "@shikijs/rehype": "^4.4.3",
    "fastify": "^5.12.0",
    "rehype-raw": "^7.0.0",
    "rehype-sanitize": "^6.0.0",
    "rehype-stringify": "^10.0.1",
    "remark-gfm": "^4.0.1",
    "remark-parse": "^11.0.0",
    "remark-rehype": "^11.1.2",
    "unified": "^11.0.5",
    "unist-util-visit": "^5.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/hast": "^3.0.4",
    "@types/node": "^24.10.1",
    "tsx": "^4.23.1",
    "typescript": "5.9.3"
  }
}
```

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Run: `pnpm install`
Expected: the workspace resolves `@keco/api` and installs the new dependencies.

- [ ] **Step 2: Write the failing env test**

Create `apps/api/src/env.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

/** The minimum a real deployment must set; everything else has a defensible default. */
const REQUIRED = {
  MEILI_MASTER_KEY: 'master-key',
  SESSION_SECRET: 'a'.repeat(32),
};

describe('loadEnv', () => {
  it('fills in defaults for everything optional', () => {
    const env = loadEnv({ ...REQUIRED });
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.MEILI_HOST).toBe('http://localhost:7700');
    expect(env.CACHE_DIR).toBe('.cache');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from the string the environment always gives it', () => {
    expect(loadEnv({ ...REQUIRED, PORT: '8080' }).PORT).toBe(8080);
  });

  it('names the offending variable when one is missing', () => {
    // A server that boots with half a configuration fails later, in a request, at 3am.
    expect(() => loadEnv({ SESSION_SECRET: 'a'.repeat(32) })).toThrow(/MEILI_MASTER_KEY/);
  });

  it('rejects a session secret too short to sign a cookie with', () => {
    expect(() => loadEnv({ ...REQUIRED, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects a malformed MEILI_HOST rather than failing on first query', () => {
    expect(() => loadEnv({ ...REQUIRED, MEILI_HOST: 'not-a-url' })).toThrow(/MEILI_HOST/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/env.test.ts`
Expected: FAIL — `Failed to resolve import "./env"`.

- [ ] **Step 4: Write `apps/api/src/env.ts`**

```typescript
import { z } from 'zod';

/**
 * Configuration, validated once at boot (AGENTS.md §13: validate every external payload with
 * zod at the boundary — the environment is one). A missing variable takes the process down
 * with the variable's name in the message, rather than surfacing as a confusing failure in
 * some request hours later.
 *
 * Nothing here is `VITE_`-prefixed. Those are inlined into the browser bundle at build time
 * and are public forever (§12); the portal reads its own, and none of them are secrets.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  /** Absolute base for canonical links and the sitemap. */
  SITE_URL: z.url().default('http://localhost:3000'),

  MEILI_HOST: z.url().default('http://localhost:7700'),
  /** Server-side only, and the only copy in the system (§12). */
  MEILI_MASTER_KEY: z.string().min(1),

  /** Read-only, by key. Relative paths resolve against the workspace root (§3). */
  CACHE_DIR: z.string().min(1).default('.cache'),
  /** Where `vite build` put the portal. Served by @fastify/static. */
  WEB_DIST: z.string().min(1).default('apps/web/dist'),

  /** Signs the admin session cookie. 32 bytes minimum. */
  SESSION_SECRET: z.string().min(32),
  /** `scrypt$<salt>$<key>` — produced by `mise run admin:hash` (§12). */
  ADMIN_PASSWORD_HASH: z.string().min(1).optional(),
  /** Accepted by /api/commands/* in place of an admin session (§12). */
  COMMAND_TOKEN: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`apps/api: invalid environment\n${issues}`);
}
```

- [ ] **Step 5: Run the env test to verify it passes**

Run: `pnpm vitest run apps/api/src/env.test.ts`
Expected: PASS — 5 cases green.

- [ ] **Step 6: Write the failing server test**

Create `apps/api/src/server.test.ts`:

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from './env';
import { build } from './server';

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });
const app = await build({ env });

afterAll(() => app.close());

describe('build()', () => {
  it('reports its own health without touching Meilisearch', async () => {
    // Health must not depend on a downstream: a probe that fails when the search index is
    // down takes the process out of rotation for something it cannot fix by restarting.
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers an unknown /api path with JSON, never the SPA shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/server.test.ts`
Expected: FAIL — `Failed to resolve import "./server"`.

- [ ] **Step 8: Write the shared handles and the server**

Create `apps/api/src/query.ts`:

```typescript
import { createQueryClient, type QueryClient } from '@keco/query';
import type { Env } from './env';

/**
 * The read side's one Meilisearch handle (AGENTS.md §11). REST, MCP and chat are thin
 * adapters over @keco/query — a capability in one and not the others is a bug.
 *
 * The portal does not use this: it queries Meilisearch from the browser with a search-only
 * key (§9). This client holds the master key and never leaves the server.
 */
export const queryClient = (env: Env): QueryClient =>
  createQueryClient({ MEILI_HOST: env.MEILI_HOST, MEILI_MASTER_KEY: env.MEILI_MASTER_KEY });
```

Create `apps/api/src/cache.ts`:

```typescript
import { createCacheFromEnv, type Cache } from '@keco/cache';
import type { Env } from './env';

/**
 * The one place the read side touches write-side storage (AGENTS.md §9): reads, by key, of
 * immutable blobs. Never write, never list — a directory scan here is the §14 mistake that
 * becomes billed-per-request the day object storage lands.
 */
export const readCache = (env: Env): Cache => createCacheFromEnv({ CACHE_DIR: env.CACHE_DIR });
```

Create `apps/api/src/server.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env';

export type BuildOptions = {
  env: Env;
  /**
   * Paths the prerender emitted, loaded from the build manifest. Injected rather than read
   * here so tests can exercise the fallback without a dist directory. Task 9 wires the real
   * loader in `index.ts`.
   */
  prerendered?: Set<string>;
};

/**
 * Builds the instance without listening, so every test drives it through `inject` and no
 * test opens a socket. `index.ts` is the only thing that calls `.listen()`.
 *
 * Registration order is load-bearing (§14): /api routes first, then the static plugin, then
 * the not-found handler last. Task 9 adds the last two.
 */
export async function build(options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.env.LOG_LEVEL },
    // owner/repo paths are the public identifier; nothing here needs a trailing-slash variant.
    ignoreTrailingSlash: true,
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  // Replaced in Task 9 by the handler that also serves the SPA and the prerendered pages.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));

  await app.ready();
  return app;
}
```

Create `apps/api/src/index.ts`:

```typescript
import { loadEnv } from './env';
import { build } from './server';

/**
 * The process entry, and the only place that listens. Everything else builds an instance and
 * injects into it.
 */
const env = loadEnv();
const app = await build({ env });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
```

- [ ] **Step 9: Run the server test to verify it passes**

Run: `pnpm vitest run apps/api && pnpm -F @keco/api check`
Expected: PASS — both env and server suites green, `tsc --noEmit` silent.

- [ ] **Step 10: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): scaffold the Fastify deployable

build() returns a configured instance without listening, so tests drive it with
inject and never open a socket. Env is zod-validated at boot and names the
offending variable. Adds the read-only cache handle and the single Meilisearch
query client (AGENTS.md §11, §12)."
```

---

## Task 4: Port the public REST routes

`/api/v1/search` and `/api/v1/tools/:owner/:repo`, moved off Next and hardened: the `?sort=` cast becomes a narrowing, and per-IP rate limiting stops being a TODO.

**Files:**
- Create: `apps/api/src/routes/v1.ts`, `apps/api/src/routes/v1.test.ts`
- Modify: `apps/api/src/server.ts`
- Delete (later, in Task 10): the Next equivalents

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1.test.ts`. It builds the app against a fake query client so the
suite needs no running Meilisearch:

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import type { ToolDocument } from '@keco/core';
import { loadEnv } from '../env';
import { build } from '../server';

const tool = {
  id: 'ahmetb__kubectx',
  owner: 'ahmetb',
  name: 'kubectx',
  full_name: 'ahmetb/kubectx',
  summary: 'Fast context and namespace switching for kubectl.',
  kind: 'cli',
  domains: ['dev-experience'],
  stars: 18000,
  archived: false,
  repo_url: 'https://github.com/ahmetb/kubectx',
  install_methods: [
    { method: 'brew', command: 'brew install kubectx', source_url: 'https://formulae.brew.sh/formula/kubectx', verified_at: '2026-08-01T00:00:00.000Z' },
  ],
  score: { popularity: 0.9, activity: 0.8, adoption: 0.9, quality: 0.8, quality_coverage: 0.75, total: 0.86, momentum: 1.2 },
  indexed_at: '2026-08-18T00:00:00.000Z',
} as unknown as ToolDocument;

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });

/** Records what each route asked retrieval for, so the tests can assert on the translation. */
const calls: unknown[] = [];

const app = await build({
  env,
  retrieval: {
    searchTools: async (params) => {
      calls.push(params);
      return { hits: [tool], total: 1, page: 1, hitsPerPage: 20, facets: { kind: { cli: 1 } }, processingTimeMs: 3 };
    },
    getTool: async (fullName) => (fullName === 'ahmetb/kubectx' ? tool : null),
  },
});

afterAll(() => app.close());

describe('GET /api/v1/search', () => {
  it('returns the public projection, never the raw document id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=context' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.results[0]).toMatchObject({
      repo: 'ahmetb/kubectx',
      url: '/tools/ahmetb/kubectx',
      repo_url: 'https://github.com/ahmetb/kubectx',
      indexed_at: '2026-08-18T00:00:00.000Z',
    });
    // The public identifier is owner/repo; internal ids never leak (§11).
    expect(body.results[0]).not.toHaveProperty('id');
  });

  it('is CORS-open, because it is anonymous and read-only', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search' });
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('reads taxonomy facets from their declared URL parameters', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?domain=security,policy&install=krew' });
    expect(calls.at(-1)).toMatchObject({
      filters: { domains: ['security', 'policy'], install_methods: ['krew'] },
    });
  });

  it('falls back to relevance for a sort key that is not in the vocabulary', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?sort=stars:desc;drop' });
    expect(calls.at(-1)).toMatchObject({ sort: 'relevance' });
  });

  it('caps the page size so one caller cannot ask for the whole corpus', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/search?limit=5000' });
    expect(calls.at(-1)).toMatchObject({ hitsPerPage: 50 });
  });
});

describe('when Meilisearch is unreachable', () => {
  it('answers 503 without leaking a stack trace', async () => {
    const broken = await build({
      env,
      retrieval: {
        searchTools: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:7700');
        },
        getTool: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:7700');
        },
      },
    });

    const response = await broken.inject({ method: 'GET', url: '/api/v1/search?q=x' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'search_unavailable' });
    // An internal address and a stack are operational detail, not a public API.
    expect(response.body).not.toContain('ECONNREFUSED');
    await broken.close();
  });
});

describe('GET /api/v1/tools/:owner/:repo', () => {
  it('returns the full document', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tools/ahmetb/kubectx' });
    expect(response.statusCode).toBe(200);
    expect(response.json().full_name).toBe('ahmetb/kubectx');
  });

  it('404s a repo that is not in the index', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tools/nobody/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/v1.test.ts`
Expected: FAIL — `build()` has no `retrieval` option, and `/api/v1/search` 404s.

- [ ] **Step 3: Add the retrieval seam**

The seam exists so route tests never need a live Meilisearch. It goes in its own module, not
in `server.ts`: `server.ts` imports every route, so a route importing back from `server.ts`
would be a circular import — harmless for a type, a real hazard for a value.

Create `apps/api/src/ports.ts`:

```typescript
import type { ToolDocument } from '@keco/core';
import { getTool, searchTools, type SearchParams, type SearchResult } from '@keco/query';
import type { Env } from './env';
import { queryClient } from './query';

/**
 * The two seams the routes reach the outside world through, and the reason every route test
 * in apps/api runs without a Meilisearch or a `.cache` directory.
 *
 * They live here rather than in `server.ts` so the dependency arrow only ever points one way:
 * server → routes → ports. A route importing from `server.ts` closes a cycle.
 */
export type Retrieval = {
  searchTools(params: SearchParams): Promise<SearchResult>;
  getTool(fullName: string): Promise<ToolDocument | null>;
};

/** The real thing: @keco/query bound to the master-key client (§11). */
export const liveRetrieval = (env: Env): Retrieval => {
  const client = queryClient(env);
  return {
    searchTools: (params) => searchTools(client, params),
    getTool: (fullName) => getTool(client, fullName),
  };
};
```

In `apps/api/src/server.ts`, add `import { liveRetrieval, type Retrieval } from './ports';`,
extend `BuildOptions` with `retrieval?: Retrieval;` and, at the top of `build()`, resolve it:

```typescript
  const retrieval = options.retrieval ?? liveRetrieval(options.env);
```

Then register the routes before the not-found handler:

```typescript
  await app.register(v1Routes, { prefix: '/api/v1', retrieval });
```

with `import { v1Routes } from './routes/v1';` at the top.

- [ ] **Step 4: Write `apps/api/src/routes/v1.ts`**

```typescript
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { isSortKey, selectionFromParams } from '@keco/core';
import type { FastifyPluginAsync } from 'fastify';
import type { Retrieval } from '../ports';

/**
 * Public REST (AGENTS.md §11): read-only, anonymous, CORS-open, IP rate-limited. A thin
 * adapter over @keco/query — REST, MCP and the portal share one retrieval implementation, so
 * a capability in one and not the others is a bug.
 *
 * CORS and the rate limiter are registered inside this plugin, not globally: /api/commands/*
 * must have neither (§12).
 */
export const v1Routes: FastifyPluginAsync<{ retrieval: Retrieval }> = async (app, options) => {
  const { retrieval } = options;

  await app.register(cors, { origin: '*', methods: ['GET', 'OPTIONS'] });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  /**
   * Meilisearch being down is a dependency failure, not a caller error: 503, and the reason
   * goes to the log rather than to the response. An internal host and a stack trace are
   * operational detail. Scoped to this plugin, so it cannot swallow errors from the admin or
   * command routes.
   */
  app.setErrorHandler((error, request, reply) => {
    if (reply.statusCode >= 400 && reply.statusCode < 500) return reply.send(error);
    request.log.error({ err: error }, 'read model unavailable');
    return reply.code(503).send({ error: 'search_unavailable' });
  });

  app.get('/search', async (request) => {
    const params = new URLSearchParams(
      request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '',
    );

    const sort = params.get('sort') ?? '';
    const results = await retrieval.searchTools({
      q: params.get('q') ?? '',
      filters: selectionFromParams(params),
      // Narrowed, not cast: a hand-edited ?sort= must never reach Meilisearch verbatim.
      sort: isSortKey(sort) ? sort : 'relevance',
      page: Math.max(1, Number(params.get('page') ?? 1) || 1),
      hitsPerPage: Math.min(50, Math.max(1, Number(params.get('limit') ?? 20) || 20)),
    });

    return {
      total: results.total,
      page: results.page,
      // The public identifier is owner/repo — internal ids never leak (§11).
      results: results.hits.map((tool) => ({
        repo: tool.full_name,
        summary: tool.summary,
        kind: tool.kind,
        domains: tool.domains,
        stars: tool.stars,
        score: tool.score.total,
        install_methods: tool.install_methods,
        url: `/tools/${tool.full_name}`,
        repo_url: tool.repo_url,
        // Eventual consistency is the contract; freshness is shown, never hidden (§2.7).
        indexed_at: tool.indexed_at,
      })),
      facets: results.facets,
    };
  });

  app.get<{ Params: { owner: string; repo: string } }>('/tools/:owner/:repo', async (request, reply) => {
    const { owner, repo } = request.params;
    const tool = await retrieval.getTool(`${owner}/${repo}`);
    if (!tool) return reply.code(404).send({ error: 'not_found' });
    return tool;
  });
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/api && pnpm -F @keco/api check`
Expected: PASS — 8 v1 cases plus the earlier suites.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): port the public REST routes to Fastify

/api/v1/search and /api/v1/tools/:owner/:repo, with CORS, per-IP rate limiting and
a 503 error handler scoped to the v1 plugin so /api/commands/* inherits none of
them. ?sort= is narrowed with isSortKey rather than cast, and the page size is
clamped. Retrieval is injected through ports.ts, so route tests need no running
Meilisearch."
```

---

## Task 5: The README rendering pipeline

Pure markdown → sanitised HTML. No I/O, so it is unit-testable on fixture strings. §14 is blunt about this one: rendering untrusted README markdown without a server-side sanitise step is a stored-XSS hole across the whole corpus.

**Files:**
- Create: `apps/api/src/readme/rewrite-urls.ts`, `apps/api/src/readme/strip-badges.ts`
- Create: `apps/api/src/readme/render.ts`, `apps/api/src/readme/render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/readme/render.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { renderReadme } from './render';

const BASE = 'https://raw.githubusercontent.com/kubernetes/kubectl/HEAD/';

describe('renderReadme', () => {
  it('renders ordinary markdown', async () => {
    const html = await renderReadme('# Title\n\nSome **bold** prose.', BASE);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('strips script tags', async () => {
    // READMEs are untrusted input from 30k strangers (§14).
    const html = await renderReadme('Hello\n\n<script>alert(1)</script>', BASE);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('strips inline event handlers and javascript: URLs', async () => {
    const html = await renderReadme('<img src="x" onerror="alert(1)">\n\n[go](javascript:alert(1))', BASE);
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
  });

  it('rewrites relative image paths against image_base_url', async () => {
    // Relative README images break unless rewritten — test with kubernetes/kubectl (§14).
    const html = await renderReadme('![logo](docs/logo.png)', BASE);
    expect(html).toContain(`${BASE}docs/logo.png`);
  });

  it('rewrites relative links but leaves absolute ones alone', async () => {
    const html = await renderReadme('[docs](docs/readme.md) and [gh](https://github.com/x/y)', BASE);
    expect(html).toContain(`${BASE}docs/readme.md`);
    expect(html).toContain('https://github.com/x/y');
  });

  it('leaves anchors alone', async () => {
    const html = await renderReadme('[top](#installation)', BASE);
    expect(html).toContain('href="#installation"');
  });

  it('drops a leading badge-only paragraph', async () => {
    const markdown = [
      '# kubectx',
      '',
      '[![build](https://img.shields.io/badge/build-passing-green)](https://ci.example/x)',
      '[![license](https://img.shields.io/badge/license-Apache-blue)](https://example/l)',
      '',
      'Real prose starts here.',
    ].join('\n');
    const html = await renderReadme(markdown, BASE);
    expect(html).toContain('<h1>kubectx</h1>');
    expect(html).toContain('Real prose starts here.');
    expect(html).not.toContain('img.shields.io');
  });

  it('keeps a paragraph that only looks like badges but carries prose', async () => {
    const markdown = '# x\n\n![logo](logo.png) A real sentence about the project.';
    const html = await renderReadme(markdown, BASE);
    expect(html).toContain('A real sentence about the project.');
  });

  it('highlights fenced code with Shiki', async () => {
    const html = await renderReadme('```bash\nkubectl get pods\n```', BASE);
    expect(html).toContain('shiki');
    expect(html).toContain('kubectl');
  });

  it('renders GitHub-flavoured tables', async () => {
    const html = await renderReadme('| a | b |\n| - | - |\n| 1 | 2 |', BASE);
    expect(html).toContain('<table>');
  });

  it('keeps details/summary, which READMEs lean on for collapsible sections', async () => {
    const html = await renderReadme('<details><summary>More</summary>\n\nhidden\n\n</details>', BASE);
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/readme/render.test.ts`
Expected: FAIL — `Failed to resolve import "./render"`.

- [ ] **Step 3: Write the URL-rewriting plugin**

Create `apps/api/src/readme/rewrite-urls.ts`:

```typescript
import type { Element, Root } from 'hast';
import { visit } from 'unist-util-visit';

/**
 * Relative README image and link paths break outside GitHub unless rewritten against the
 * repo's `image_base_url` (AGENTS.md §14 — test with kubernetes/kubectl).
 *
 * Runs after rehype-sanitize, so by the time this sees an attribute the dangerous schemes are
 * already gone. It only touches values that are relative: an absolute URL, a protocol-relative
 * one and a fragment are all left exactly as the author wrote them.
 */
const URL_ATTRIBUTE: Record<string, string> = { img: 'src', a: 'href', source: 'srcset' };

/** Anything with a scheme, protocol-relative, or a pure fragment is already resolvable. */
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

export function rewriteUrls(options: { base: string }) {
  return (tree: Root): void => {
    visit(tree, 'element', (node: Element) => {
      const attribute = URL_ATTRIBUTE[node.tagName];
      if (!attribute) return;

      const value = node.properties[attribute];
      if (typeof value !== 'string' || value === '' || ABSOLUTE.test(value)) return;

      try {
        node.properties[attribute] = new URL(value, options.base).toString();
      } catch {
        // An unresolvable path is left as-is rather than dropping the element: a broken image
        // is a cosmetic bug, a thrown render is a 500 on a page that was otherwise fine.
      }
    });
  };
}
```

- [ ] **Step 4: Write the badge-stripping plugin**

Create `apps/api/src/readme/strip-badges.ts`:

```typescript
import type { ElementContent, Root, RootContent } from 'hast';

/**
 * Drops the badge wall most READMEs open with (§9). It is noise on a tool page — the health
 * signals Keco shows come from Scorecard and the score axes, not from a shields.io image.
 *
 * Deliberately narrow: it removes at most one paragraph, only if that paragraph contains
 * nothing but images, links wrapping images, line breaks and whitespace, and only if it is
 * the first real content — allowing for the title heading READMEs usually put above it. A
 * paragraph carrying one logo and a sentence of prose is left alone.
 */
const isBadgeContent = (node: ElementContent): boolean => {
  if (node.type === 'text') return node.value.trim() === '';
  if (node.type !== 'element') return false;
  if (node.tagName === 'img' || node.tagName === 'br') return true;
  if (node.tagName === 'a') return node.children.every(isBadgeContent);
  return false;
};

const isBlank = (node: RootContent): boolean => node.type === 'text' && node.value.trim() === '';

export function stripBadgeParagraph() {
  return (tree: Root): void => {
    for (const [index, node] of tree.children.entries()) {
      if (isBlank(node)) continue;
      if (node.type !== 'element') return;

      // The title, and any subtitle heading above the badges, are skipped over.
      if (/^h[1-6]$/.test(node.tagName)) continue;

      if (node.tagName !== 'p') return;
      if (node.children.length === 0) return;
      if (!node.children.every(isBadgeContent)) return;
      // A paragraph of pure whitespace is not a badge wall.
      if (!node.children.some((child) => child.type === 'element' && child.tagName !== 'br')) return;

      tree.children.splice(index, 1);
      return;
    }
  };
}
```

- [ ] **Step 5: Write the renderer**

Create `apps/api/src/readme/render.ts`:

```typescript
import rehypeShiki from '@shikijs/rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { rewriteUrls } from './rewrite-urls';
import { stripBadgeParagraph } from './strip-badges';

/**
 * Cached README markdown → sanitised HTML (AGENTS.md §9). Pure: the caller reads the bytes
 * out of the cache and passes them in, so this is testable on fixture strings.
 *
 * Plugin order is the security property, and it is not rearrangeable:
 *
 *   remark-rehype(allowDangerousHtml) → rehype-raw   parses the inline HTML READMEs contain
 *   rehype-sanitize                                  removes it if it is dangerous
 *   stripBadgeParagraph, rewriteUrls                 cosmetics, on already-safe markup
 *   rehype-shiki                                     generates its own markup from safe text
 *
 * Sanitising before rehype-raw would sanitise a tree that does not yet contain the raw HTML,
 * which is the classic way to ship a hole that looks defended. Shiki runs last on purpose:
 * its `style` and `class` output would be stripped if sanitize came after it, and it only
 * ever emits markup derived from text content that sanitize has already cleared.
 */
const schema = {
  ...defaultSchema,
  // READMEs use these constantly for collapsible sections, and neither can execute anything.
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary'],
};

/**
 * Built once. Shiki loads grammars and themes on first use, which is slow enough that doing
 * it per request would be visible; unified processors are safe to reuse across calls.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(stripBadgeParagraph)
  .use(rehypeShiki, { themes: { light: 'github-light', dark: 'github-dark' } })
  .use(rehypeStringify)
  .freeze();

export async function renderReadme(markdown: string, imageBaseUrl: string): Promise<string> {
  const file = await processor().use(rewriteUrls, { base: imageBaseUrl }).process(markdown);
  return String(file);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/src/readme/render.test.ts`
Expected: PASS — 11 cases green. If the Shiki case is slow on first run, that is grammar
loading; it is paid once per process.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/readme
git commit -m "feat(api): render cached README markdown to sanitised HTML

rehype-raw then rehype-sanitize then cosmetics then Shiki — the order is the
security property, not a preference. Relative image and link paths are rewritten
against image_base_url, and the opening badge paragraph is dropped. Pure, so it
is tested on fixture strings with no cache or network (AGENTS.md §9, §14)."
```

---

## Task 6: The `/api/readme` route

Wires the renderer to the cache. This is the read side's only touch of write-side storage: a read, by key, of an immutable blob.

**Files:**
- Create: `apps/api/src/routes/readme.ts`, `apps/api/src/routes/readme.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/readme.test.ts`:

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { build } from '../server';

const env = loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' });

const files: Record<string, string> = {
  'repos/ahmetb/kubectx/readme.md': '# kubectx\n\n<script>alert(1)</script>\n\n![logo](docs/l.png)',
  'repos/ahmetb/kubectx/readme.json': JSON.stringify({
    path: 'README.md',
    branch: 'master',
    etag: null,
    image_base_url: 'https://raw.githubusercontent.com/ahmetb/kubectx/master/',
  }),
};

const app = await build({
  env,
  retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
  cache: {
    getText: async (key: string) => files[key] ?? null,
    getJSON: async <T>(key: string) => (files[key] ? (JSON.parse(files[key]) as T) : null),
  },
});

afterAll(() => app.close());

describe('GET /api/readme/:owner/:repo', () => {
  it('returns sanitised HTML with relative images rewritten', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/readme/ahmetb/kubectx' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.repo).toBe('ahmetb/kubectx');
    expect(body.html).toContain('<h1>kubectx</h1>');
    expect(body.html).not.toContain('<script');
    expect(body.html).toContain('https://raw.githubusercontent.com/ahmetb/kubectx/master/docs/l.png');
  });

  it('404s a repo whose README is not cached yet', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/readme/nobody/nothing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('rejects a repo name that could escape the cache key space', async () => {
    // The cache key is built from user input; a traversal here would read arbitrary blobs.
    const response = await app.inject({ method: 'GET', url: '/api/readme/ahmetb/..%2f..%2fjournal' });
    expect(response.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/readme.test.ts`
Expected: FAIL — `build()` has no `cache` option and `/api/readme/*` 404s.

- [ ] **Step 3: Add the cache seam**

Add to `apps/api/src/ports.ts`, alongside `Retrieval` — merge the `import` into the block
already at the top of that file rather than leaving it mid-module:

```typescript
import { readCache } from './cache';

/**
 * The slice of the cache the read side is allowed to use: two reads, by key. Injectable so
 * route tests need no `.cache` directory on disk. Nothing here can write or list — that is
 * the §2.2 contract, expressed as a type rather than a comment.
 */
export type ReadOnlyCache = {
  getText(key: string): Promise<string | null>;
  getJSON<T>(key: string): Promise<T | null>;
};

export const liveCache = (env: Env): ReadOnlyCache => readCache(env);
```

In `apps/api/src/server.ts`, add `liveCache` and `type ReadOnlyCache` to the `./ports` import,
extend `BuildOptions` with `cache?: ReadOnlyCache;`, and resolve it next to `retrieval`:

```typescript
  const cache = options.cache ?? liveCache(options.env);
```

and register the route:

```typescript
  await app.register(readmeRoutes, { prefix: '/api/readme', cache });
```

with `import { readmeRoutes } from './routes/readme';` at the top.

- [ ] **Step 4: Write `apps/api/src/routes/readme.ts`**

```typescript
import { repoKeys } from '@keco/cache/keys';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { renderReadme } from '../readme/render';
import type { ReadOnlyCache } from '../ports';

/**
 * The README comes from the cache, never from the index (AGENTS.md §9) — and the browser
 * cannot read the cache, so it comes through here. A read of an immutable blob, by key:
 * never a write, never a list (§2.2, §14).
 */
type ReadmeMeta = {
  path: string;
  branch: string;
  etag: string | null;
  /** Relative README image paths break unless rewritten against this (§14). */
  image_base_url: string;
};

/**
 * The cache key is built from path parameters, so the vocabulary is pinned to what GitHub
 * actually allows in an owner or repo name. Without this, `..%2f..%2f` reads arbitrary blobs.
 */
const Params = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
});

export const readmeRoutes: FastifyPluginAsync<{ cache: ReadOnlyCache }> = async (app, options) => {
  const { cache } = options;

  app.get<{ Params: { owner: string; repo: string } }>('/:owner/:repo', async (request, reply) => {
    const parsed = Params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const fullName = `${parsed.data.owner}/${parsed.data.repo}`;
    const keys = repoKeys(fullName);

    const [markdown, meta] = await Promise.all([
      cache.getText(keys.readme),
      cache.getJSON<ReadmeMeta>(keys.readmeMeta),
    ]);

    if (markdown === null) return reply.code(404).send({ error: 'not_found' });

    const html = await renderReadme(
      markdown,
      // A cached README with no cached metadata is a crawler gap, not a reason to 500. GitHub's
      // own raw host resolves relative paths correctly for the default branch.
      meta?.image_base_url ?? `https://raw.githubusercontent.com/${fullName}/HEAD/`,
    );

    return reply
      .header('cache-control', 'public, max-age=300')
      .send({ repo: fullName, html });
  });
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/api && pnpm -F @keco/api check`
Expected: PASS — the three readme cases plus every earlier suite.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat(api): serve the cached README as sanitised HTML

GET /api/readme/:owner/:repo reads readme.md and readme.json through the Storage
port, by key, and returns rendered HTML. Owner and repo are validated against
GitHub's own vocabulary before they reach a cache key. The cache seam is typed
down to two reads, so the route cannot write or list (AGENTS.md §2.2, §9)."
```

---

## Task 7: Admin session auth

§12 replaces the Auth.js + GitHub OAuth design the Next layout assumed with a single admin credential. There is one admin, and the backoffice can only read and enqueue.

**Files:**
- Create: `apps/api/src/auth.ts`, `apps/api/src/auth.test.ts`
- Create: `apps/api/src/bin/hash-password.ts`
- Create: `apps/api/src/routes/admin.ts`, `apps/api/src/routes/admin.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the failing auth test**

Create `apps/api/src/auth.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { constantTimeEquals, hashPassword, verifyPassword } from './auth';

describe('hashPassword / verifyPassword', () => {
  it('round-trips the right password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct Horse Battery Staple', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects a malformed stored value instead of throwing', async () => {
    // A half-configured ADMIN_PASSWORD_HASH must fail closed, not 500 the login route.
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$aa$bb')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$zz$zz')).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('compares equal strings as equal', () => {
    expect(constantTimeEquals('token', 'token')).toBe(true);
  });

  it('rejects different values, including different lengths', () => {
    expect(constantTimeEquals('token', 'tokes')).toBe(false);
    expect(constantTimeEquals('token', 'token-longer')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/auth.test.ts`
Expected: FAIL — `Failed to resolve import "./auth"`.

- [ ] **Step 3: Write `apps/api/src/auth.ts`**

```typescript
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Backoffice auth is a single admin credential, not an auth system (AGENTS.md §12). There is
 * one admin and the backoffice can only read and enqueue, so an OAuth provider would be more
 * moving parts than the surface justifies.
 *
 * scrypt rather than a bare digest: ADMIN_PASSWORD_HASH sits in an env file, and a password
 * hashed with sha256 there is a password, not a hash.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SCHEME = 'scrypt';

/** Produces the `ADMIN_PASSWORD_HASH` value. See `src/bin/hash-password.ts`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Fails closed on anything it does not recognise. A malformed or empty stored value means the
 * deployment is misconfigured, and the safe reading of that is "nobody is the admin".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== SCHEME || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const salt = Buffer.from(saltHex, 'hex');
  if (expected.length !== KEY_LENGTH || salt.length === 0) return false;

  const actual = await scrypt(password, salt, KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}

/**
 * For the command token (§12). An empty expected value is never equal to anything — an unset
 * COMMAND_TOKEN must not make every caller authorized.
 */
export function constantTimeEquals(provided: string, expected: string): boolean {
  if (expected === '' || provided === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a leak of nothing useful:
  // the length of a token is not a secret, but the comparison still must not short-circuit.
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Write the hashing CLI**

Create `apps/api/src/bin/hash-password.ts`:

```typescript
import { hashPassword } from '../auth';

/**
 * `mise run admin:hash -- --password 'secret'` → the value for ADMIN_PASSWORD_HASH.
 *
 * Reads the password from an argument rather than prompting: this is run once, by a human,
 * when a deployment is set up.
 */
const index = process.argv.indexOf('--password');
const password = index === -1 ? undefined : process.argv[index + 1];

if (!password) {
  console.error("usage: mise run admin:hash -- --password '<password>'");
  process.exit(2);
}

console.log(await hashPassword(password));
```

- [ ] **Step 5: Run the auth test to verify it passes**

Run: `pnpm vitest run apps/api/src/auth.test.ts`
Expected: PASS — 6 cases green.

- [ ] **Step 6: Write the failing admin route test**

Create `apps/api/src/routes/admin.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../auth';
import { loadEnv } from '../env';
import { build } from '../server';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await build({
    env: loadEnv({
      MEILI_MASTER_KEY: 'k',
      SESSION_SECRET: 'a'.repeat(32),
      LOG_LEVEL: 'fatal',
      ADMIN_PASSWORD_HASH: await hashPassword('hunter2'),
    }),
    retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
    cache: { getText: async () => null, getJSON: async () => null },
  });
});

afterAll(() => app.close());

const login = (password: string) =>
  app.inject({ method: 'POST', url: '/api/admin/login', payload: { password } });

describe('POST /api/admin/login', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie on the right password', async () => {
    const response = await login('hunter2');
    expect(response.statusCode).toBe(200);
    const cookie = response.headers['set-cookie'];
    const header = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });

  it('rejects the wrong password without saying which part was wrong', async () => {
    const response = await login('wrong');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a malformed body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/admin/session', () => {
  it('reports no session before login', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/admin/session' });
    expect(response.statusCode).toBe(401);
  });

  it('reports a session after login, and none after logout', async () => {
    const cookies = (await login('hunter2')).cookies.map((c) => [c.name, c.value] as const);
    const jar = Object.fromEntries(cookies);

    const session = await app.inject({ method: 'GET', url: '/api/admin/session', cookies: jar });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ admin: true });

    const out = await app.inject({ method: 'POST', url: '/api/admin/logout', cookies: jar });
    expect(out.statusCode).toBe(200);
  });
});

describe('when ADMIN_PASSWORD_HASH is unset', () => {
  it('refuses every login rather than letting anyone in', async () => {
    const open = await build({
      env: loadEnv({ MEILI_MASTER_KEY: 'k', SESSION_SECRET: 'a'.repeat(32), LOG_LEVEL: 'fatal' }),
      retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
      cache: { getText: async () => null, getJSON: async () => null },
    });
    const response = await open.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: 'anything' },
    });
    expect(response.statusCode).toBe(401);
    await open.close();
  });
});
```

- [ ] **Step 7: Create the session module**

Both the admin routes and the commands routes need to read a session, and `server.ts` imports
both — so the helper lives in neither. Create `apps/api/src/session.ts`:

```typescript
import type { FastifyRequest } from 'fastify';

/** The signed admin session cookie (§12). One admin, one cookie, no roles. */
export const SESSION_COOKIE = 'keco_admin';

/**
 * True when the request carries a valid signed admin session.
 *
 * Every handler that needs this calls it directly. §12 is explicit that authorization belongs
 * inside the handler, not only in a plugin hook — a route that trusts an upstream guard is one
 * refactor away from being unguarded.
 */
export function hasAdminSession(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value === 'admin';
}
```

- [ ] **Step 8: Register the cookie plugin and the admin routes**

In `apps/api/src/server.ts`, add the imports:

```typescript
import cookie from '@fastify/cookie';
import { adminRoutes } from './routes/admin';
```

and, before the `/api/health` route, register the cookie plugin with the signing secret:

```typescript
  // Signed so a session cookie cannot be forged. HttpOnly and SameSite are set per-cookie
  // by the admin routes (§12).
  await app.register(cookie, { secret: options.env.SESSION_SECRET });
```

then, after the v1 and readme registrations:

```typescript
  await app.register(adminRoutes, { prefix: '/api/admin', env: options.env });
```

- [ ] **Step 9: Write `apps/api/src/routes/admin.ts`**

```typescript
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../auth';
import type { Env } from '../env';
import { SESSION_COOKIE, hasAdminSession } from '../session';

/**
 * Backoffice auth (AGENTS.md §12): one admin credential, a signed HttpOnly session cookie,
 * and nothing else. The backoffice can only read and enqueue, so there is no role model to
 * build.
 *
 * The backoffice SPA itself is not in this deployment yet; these routes are the contract it
 * will use, and /api/commands/* already accepts the session they issue.
 */
const Credentials = z.object({ password: z.string().min(1) });

export const adminRoutes: FastifyPluginAsync<{ env: Env }> = async (app, options) => {
  const { env } = options;

  app.post('/login', async (request, reply) => {
    const parsed = Credentials.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    // An unset hash means no admin exists. Fail closed rather than treating "unconfigured"
    // as "open".
    const stored = env.ADMIN_PASSWORD_HASH ?? '';
    if (!(await verifyPassword(parsed.data.password, stored))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    return reply
      .setCookie(SESSION_COOKIE, 'admin', {
        signed: true,
        httpOnly: true,
        sameSite: 'strict',
        secure: env.SITE_URL.startsWith('https://'),
        path: '/',
        maxAge: 60 * 60 * 12,
      })
      .send({ admin: true });
  });

  app.post('/logout', async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ admin: false }),
  );

  app.get('/session', async (request, reply) => {
    // Authorize inside the handler, not only in a hook (§12).
    if (!hasAdminSession(request)) return reply.code(401).send({ error: 'unauthorized' });
    return { admin: true };
  });
};
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm vitest run apps/api && pnpm -F @keco/api check`
Expected: PASS — auth and admin suites green alongside the earlier ones.

- [ ] **Step 11: Commit**

```bash
git add apps/api
git commit -m "feat(api): single-credential admin session

scrypt-hashed ADMIN_PASSWORD_HASH, constant-time verify, signed HttpOnly
SameSite=Strict cookie. An unset hash fails closed rather than reading as open.
Every handler re-checks the session itself (AGENTS.md §12)."
```

---

## Task 8: Commands, MCP and chat

The commands endpoint is the only write path on the read side, and it writes to the *write* model. MCP and chat move across unchanged in behaviour — they were 501 under Next and they are 501 here; only the host changes.

**Files:**
- Create: `apps/api/src/routes/commands.ts`, `apps/api/src/routes/commands.test.ts`
- Create: `apps/api/src/routes/mcp.ts`, `apps/api/src/routes/chat.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/commands.test.ts`:

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { build } from '../server';

const env = loadEnv({
  MEILI_MASTER_KEY: 'k',
  SESSION_SECRET: 'a'.repeat(32),
  LOG_LEVEL: 'fatal',
  COMMAND_TOKEN: 'right-token',
});

const app = await build({
  env,
  retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
  cache: { getText: async () => null, getJSON: async () => null },
});

afterAll(() => app.close());

const post = (url: string, token?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { repo: 'ahmetb/kubectx' },
  });

describe('POST /api/commands/:command', () => {
  it('rejects a request with no credential', async () => {
    const response = await post('/api/commands/recrawl');
    expect(response.statusCode).toBe(401);
  });

  it('rejects the wrong token', async () => {
    expect((await post('/api/commands/recrawl', 'wrong-token')).statusCode).toBe(401);
  });

  it('rejects an unknown command even with the right token', async () => {
    const response = await post('/api/commands/drop-everything', 'right-token');
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('unknown_command');
  });

  it('accepts a known command with the right token', async () => {
    const response = await post('/api/commands/recrawl', 'right-token');
    // Still 501 until the journal append lands — but the auth and vocabulary gates are real.
    expect(response.statusCode).toBe(501);
    expect(response.json().command).toBe('recrawl');
  });

  it('is not CORS-open, unlike /api/v1', async () => {
    const response = await post('/api/commands/recrawl', 'right-token');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('MCP and chat', () => {
  it('lists the MCP tools by name', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/mcp' });
    expect(response.statusCode).toBe(200);
    expect(response.json().tools).toContain('search_tools');
  });

  it('reports chat as not implemented', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: {} });
    expect(response.statusCode).toBe(501);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/commands.test.ts`
Expected: FAIL — all six routes 404.

- [ ] **Step 3: Write `apps/api/src/routes/commands.ts`**

```typescript
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { constantTimeEquals } from '../auth';
import type { Env } from '../env';
import { hasAdminSession } from '../session';

/**
 * Commands (AGENTS.md §11, §12): the only write path on the read side, and it writes to the
 * *write* model — it appends a journal event or resets a checkpoint, then returns. It never
 * touches Meilisearch and it never does the work inline.
 *
 * A handler here that loops over repos is always a bug (§14): long work cannot run inside a
 * request, so handlers enqueue and workers execute.
 *
 * Auth is an admin session OR `Bearer $COMMAND_TOKEN`, compared in constant time. No CORS.
 */
const COMMANDS = ['recrawl', 'reanalyze', 'reproject', 'rebuild', 'rollback'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value);

function authorized(request: FastifyRequest, env: Env): boolean {
  // Re-checked here, inside the handler's plugin, rather than trusted from a hook (§12).
  if (hasAdminSession(request)) return true;
  const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  return constantTimeEquals(provided, env.COMMAND_TOKEN ?? '');
}

export const commandRoutes: FastifyPluginAsync<{ env: Env }> = async (app, options) => {
  const { env } = options;

  app.post<{ Params: { command: string } }>('/:command', async (request, reply) => {
    if (!authorized(request, env)) return reply.code(401).send({ error: 'unauthorized' });

    const { command } = request.params;
    if (!isCommand(command)) {
      return reply.code(400).send({ error: 'unknown_command', commands: COMMANDS });
    }

    // TODO(commands): append the corresponding event to the journal (or reset a checkpoint)
    // through @keco/cache and return 202 immediately. The workers pick it up on their next
    // pass. Tracked in ROADMAP.md under v1 → Read side → Backoffice.
    return reply.code(501).send({ error: 'not_implemented', command });
  });
};
```

- [ ] **Step 4: Write the MCP and chat placeholders**

Create `apps/api/src/routes/mcp.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify';

/**
 * MCP endpoint (AGENTS.md §11): streamable HTTP, read tools only.
 *
 * Two things decide whether Keco survives in an agent's toolset:
 *   - the tool *descriptions* are the interface. An agent picks from the description alone,
 *     so each one must say explicitly when NOT to use it.
 *   - responses stay compact. search_tools caps at 10 results with ~40-word summaries; a
 *     50 KB response burns the caller's context and gets Keco dropped.
 *
 * Every item carries `url` (the Keco page) and `repo_url` so agents can cite, plus
 * `indexed_at` — eventual consistency must be visible to callers (§2.7).
 */
export const TOOLS = [
  {
    name: 'search_tools',
    description:
      'Search the Kubernetes ecosystem (CLIs, kubectl plugins, operators, Helm charts, dashboards) by natural-language need or by facet. Returns at most 10 tools ranked by relevance then health. Use when the user needs to find or choose a Kubernetes tool. Do NOT use for general Kubernetes how-to questions, for non-Kubernetes software, or to look up a tool you already know the repo of — use get_tool for that.',
  },
  {
    name: 'get_tool',
    description:
      'Full metadata for one tool by owner/repo: summary, kind, domains, health score breakdown, and install commands verified against real registry entries. Use when you already know which tool you mean. Do NOT use to discover tools — use search_tools.',
  },
  {
    name: 'compare_tools',
    description:
      'Compare 2-5 tools by owner/repo side by side on maintenance, install methods, license and adoption. Use when the user is choosing between named alternatives. Do NOT use to find candidates — use find_alternatives first.',
  },
  {
    name: 'find_alternatives',
    description:
      'Given one tool (owner/repo), return tools of the same kind solving overlapping problems, ranked by health. Use for "what else does what X does". Do NOT use for a free-text need — use search_tools.',
  },
  {
    name: 'whats_hot',
    description:
      'Highest-momentum projects, optionally within one domain. Momentum is stars per day of repo age damped by recent activity — it is NOT a 30-day star delta and must not be described as "trending this week". Use to surface fast-growing young projects.',
  },
] as const;

// TODO(mcp): serve the streamable HTTP transport and wire these five tools to @keco/query —
// the same functions REST uses (§11). Tracked in ROADMAP.md under v2.
export const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => ({ tools: TOOLS.map((tool) => tool.name), status: 'not_implemented' }));
  app.post('/', async (_request, reply) => reply.code(501).send({ error: 'not_implemented' }));
};
```

Create `apps/api/src/routes/chat.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify';

/**
 * Chatbot (v2, AGENTS.md §11) — strictly retrieval-grounded, and the rules are not negotiable:
 *   1. retrieve first (Meilisearch hybrid), answer only from what came back
 *   2. never name a tool outside the retrieved set; never emit an install command that is not
 *      in that tool's verified install_methods — the model does not write shell commands from
 *      memory
 *   3. every recommendation renders as a tool card linking to its Keco page
 *   4. weak retrieval ⇒ say so, offer "possibly related", do not pad
 *   5. flag archived or stale suggestions
 *   6. stateless, no history, no PII, per-IP rate limit, hard token budget per request
 *   7. log (query, retrieved_ids, answer) to `traces`; evals live in packages/query/evals
 */
export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', async (_request, reply) => reply.code(501).send({ error: 'not_implemented' }));
};
```

- [ ] **Step 5: Register all three in `server.ts`**

Add the imports and, after the admin registration:

```typescript
  await app.register(commandRoutes, { prefix: '/api/commands', env: options.env });
  await app.register(mcpRoutes, { prefix: '/api/mcp' });
  await app.register(chatRoutes, { prefix: '/api/chat' });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run apps/api && pnpm -F @keco/api check`
Expected: PASS — 7 command/MCP/chat cases plus every earlier suite.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): commands, MCP and chat endpoints

Commands accept an admin session or a constant-time Bearer token, validate the
command against a closed vocabulary, and return without doing the work — the
journal append is still the open piece. MCP and chat move across as the 501s they
already were; only the host changed (AGENTS.md §11, §12, §14)."
```

---

## Task 9: Static serving and the prerendered-first fallback

The SPA has no server: a deep link like `/tools/argoproj/argo-cd` resolves only because Fastify falls back (§14). Registration order is load-bearing — static must not shadow `/api/*`, and the fallback must be last.

**Files:**
- Create: `apps/api/src/plugins/static.ts`, `apps/api/src/plugins/static.test.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/plugins/static.test.ts`. It builds a throwaway dist tree in the OS temp
directory so the test does not need a real `vite build`:

```typescript
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env';
import { build } from '../server';
import { loadPrerenderManifest } from './static';

let dist: string;
let app: FastifyInstance;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'keco-dist-'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><div id="root"></div>SPA SHELL');
  await mkdir(join(dist, 'prerendered', 'tools', 'ahmetb'), { recursive: true });
  await writeFile(
    join(dist, 'prerendered', 'tools', 'ahmetb', 'kubectx.html'),
    '<!doctype html><h1>ahmetb/kubectx</h1>PRERENDERED',
  );
  await writeFile(
    join(dist, 'prerender-manifest.json'),
    JSON.stringify({ paths: ['/tools/ahmetb/kubectx'] }),
  );
  await writeFile(join(dist, 'sitemap.xml'), '<urlset/>');

  app = await build({
    env: loadEnv({
      MEILI_MASTER_KEY: 'k',
      SESSION_SECRET: 'a'.repeat(32),
      LOG_LEVEL: 'fatal',
      WEB_DIST: dist,
    }),
    retrieval: { searchTools: async () => { throw new Error('unused'); }, getTool: async () => null },
    cache: { getText: async () => null, getJSON: async () => null },
    prerendered: await loadPrerenderManifest(dist),
  });
});

afterAll(async () => {
  await app.close();
  await rm(dist, { recursive: true, force: true });
});

describe('static serving', () => {
  it('serves index.html at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('SPA SHELL');
  });

  it('serves a real asset from the dist directory', async () => {
    const response = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<urlset/>');
  });

  it('does not shadow /api — a JSON route still answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('the not-found fallback', () => {
  it('serves the prerendered file for a path the manifest lists', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/ahmetb/kubectx' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('PRERENDERED');
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves the SPA shell for a route the prerender did not emit', async () => {
    const response = await app.inject({ method: 'GET', url: '/tools/nobody/nothing' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('SPA SHELL');
  });

  it('serves the SPA shell for a client route with no file behind it', async () => {
    const response = await app.inject({ method: 'GET', url: '/search?q=ingress' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('SPA SHELL');
  });

  it('answers an unknown /api path with JSON, never the shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).not.toContain('SPA SHELL');
  });

  it('reserves /admin as a noindex 404 until the backoffice ships', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-robots-tag']).toBe('noindex');
  });

  it('does not serve the shell for a non-GET request', async () => {
    const response = await app.inject({ method: 'POST', url: '/tools/ahmetb/kubectx' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('SPA SHELL');
  });
});

describe('loadPrerenderManifest', () => {
  it('reads the paths the prerender emitted', async () => {
    expect(await loadPrerenderManifest(dist)).toEqual(new Set(['/tools/ahmetb/kubectx']));
  });

  it('returns an empty set when there is no manifest', async () => {
    // A dev server with no prerender run must still boot; every route just falls back.
    expect(await loadPrerenderManifest(join(tmpdir(), 'keco-does-not-exist'))).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/plugins/static.test.ts`
Expected: FAIL — `Failed to resolve import "./static"`.

- [ ] **Step 3: Write `apps/api/src/plugins/static.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

/**
 * Serves the portal bundle alongside the JSON routes (AGENTS.md §7: one Node process in
 * production, next to Meilisearch and the worker container).
 *
 * Two §14 traps are the whole reason this file exists:
 *
 *   - Static must not shadow /api/*. `wildcard: false` keeps @fastify/static from claiming
 *     every unmatched path, so the JSON routes registered before it still win.
 *   - The SPA has no server. `/tools/argoproj/argo-cd` resolves only because the not-found
 *     handler falls back — add a client route without checking this and the URL 404s on a
 *     hard refresh.
 */
const Manifest = z.object({ paths: z.array(z.string()) });

const MANIFEST_FILE = 'prerender-manifest.json';

/**
 * The set of paths the prerender emitted, read once at boot.
 *
 * A membership test on our own build output, rather than an `fs.stat` per request: it is
 * faster, and it means a crafted URL can never be turned into a path lookup — nothing outside
 * this set is ever used to build a filename.
 *
 * A missing manifest is normal (a dev server, or a build before the first prerender run) and
 * yields an empty set: every route then falls back to the SPA shell.
 */
export async function loadPrerenderManifest(distDir: string): Promise<Set<string>> {
  try {
    const raw = await readFile(join(distDir, MANIFEST_FILE), 'utf8');
    return new Set(Manifest.parse(JSON.parse(raw)).paths);
  } catch {
    return new Set();
  }
}

/** Relative WEB_DIST resolves against the workspace root, like CACHE_DIR does (§3). */
export const resolveDist = (dist: string, from = process.cwd()): string =>
  isAbsolute(dist) ? dist : resolve(from, dist);

export type StaticOptions = { dist: string; prerendered: Set<string> };

export const staticPlugin: FastifyPluginAsync<StaticOptions> = async (app, options) => {
  const root = resolveDist(options.dist);

  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    // Without this, @fastify/static registers a catch-all that swallows /api/* and the SPA
    // fallback below never runs.
    wildcard: false,
    index: ['index.html'],
  });

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';

    // JSON in, JSON out. An API caller must never receive an HTML shell with a 200-looking
    // body it cannot parse.
    if (path === '/api' || path.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Reserved for apps/backoffice, which is not in this deployment yet. noindex either way:
    // §9 says /admin is never indexed and never prerendered.
    if (path === '/admin' || path.startsWith('/admin/')) {
      return reply.code(404).header('x-robots-tag', 'noindex').send({ error: 'not_found' });
    }

    // Only a document request gets the shell. A POST to a client route is a mistake, not a
    // navigation, and answering it with 200 HTML hides that.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not_found' });
    }

    if (options.prerendered.has(path)) {
      // `path` came from the manifest, not from the request, so this cannot be walked out of
      // the dist directory.
      return reply.type('text/html').sendFile(join('prerendered', `${path.slice(1)}.html`));
    }

    return reply.type('text/html').sendFile('index.html');
  });
};
```

- [ ] **Step 4: Register it last in `server.ts`**

In `apps/api/src/server.ts`, add `import { staticPlugin } from './plugins/static';`, then
**replace** the placeholder `setNotFoundHandler` from Task 3 with the plugin registration, so
the end of `build()` reads:

```typescript
  // Last, always: the static plugin owns the not-found handler, and it must see every route
  // that did not match above (§14).
  await app.register(staticPlugin, {
    dist: options.env.WEB_DIST,
    prerendered: options.prerendered ?? new Set(),
  });

  await app.ready();
  return app;
```

- [ ] **Step 5: Load the manifest in `index.ts`**

Replace the body of `apps/api/src/index.ts` with:

```typescript
import { loadEnv } from './env';
import { loadPrerenderManifest, resolveDist } from './plugins/static';
import { build } from './server';

/**
 * The process entry, and the only place that listens. Everything else builds an instance and
 * injects into it.
 */
const env = loadEnv();
const app = await build({
  env,
  // Read once at boot. A prerender run after this process started is not picked up until it
  // restarts — which is correct, because the HTML files it wrote change at the same moment.
  prerendered: await loadPrerenderManifest(resolveDist(env.WEB_DIST)),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ dist: resolveDist(env.WEB_DIST) }, 'serving the portal');
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run apps/api && pnpm -F @keco/api check`
Expected: PASS — 11 static/fallback cases plus every earlier suite. Note that
`server.test.ts`'s "unknown /api path" case now exercises the real handler.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): serve the portal bundle with a prerendered-first fallback

@fastify/static with wildcard disabled so it cannot shadow /api, and a not-found
handler that answers JSON for /api, a noindex 404 for the reserved /admin, the
prerendered file when the boot-loaded manifest lists the path, and index.html
otherwise. Manifest membership rather than fs.stat per request, so no crafted URL
is ever turned into a filename (AGENTS.md §14)."
```

---

## Task 10: Replace Next.js with Vite

Deletes the Next app and stands up the Vite shell in its place. The routes are ported in Tasks 12–14; this task gets a building, mounting SPA with a not-found route.

**Files:**
- Delete: `apps/web/next.config.ts`, `apps/web/next-env.d.ts`, `apps/web/tsconfig.tsbuildinfo`, `apps/web/src/app/**`, `apps/web/src/middleware.ts`, `apps/web/src/lib/query.ts`, `apps/web/src/lib/readme.ts`, `apps/web/.next/`
- Create: `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/app.tsx`, `apps/web/src/routes/not-found.tsx`
- Modify: `apps/web/package.json`, `apps/web/tsconfig.json`

- [ ] **Step 1: Delete the Next.js surface**

`src/lib/topics.ts` and `src/lib/topics.test.ts` are kept — they are ported in Task 11.
`src/lib/query.ts` and `src/lib/readme.ts` go: the portal now queries Meilisearch from the
browser (§9) and reads the README through `apps/api` (§7 bars a bundle from `@keco/cache`).

```bash
git rm -r apps/web/src/app apps/web/src/middleware.ts apps/web/src/lib/query.ts \
          apps/web/src/lib/readme.ts apps/web/next.config.ts apps/web/next-env.d.ts
rm -rf apps/web/.next apps/web/tsconfig.tsbuildinfo
```

- [ ] **Step 2: Rewrite `apps/web/package.json`**

```json
{
  "name": "@keco/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "prerender": "node --import tsx prerender/index.ts",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "@keco/core": "workspace:*",
    "meilisearch": "^0.60.0",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "react-router": "^8.3.0"
  },
  "devDependencies": {
    "@keco/query": "workspace:*",
    "@types/node": "^24.10.1",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4",
    "@vitejs/plugin-react": "^6.0.5",
    "tsx": "^4.23.1",
    "typescript": "5.9.3",
    "vite": "^8.2.1"
  }
}
```

`dependencies` is exactly what §7 allows a browser bundle: `@keco/core`, `meilisearch`, and
React. `@keco/query` is a **devDependency** on purpose — only `prerender/`, which is Node build
tooling, imports it, and nothing it exports reaches the bundle.

- [ ] **Step 3: Rewrite `apps/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client", "node"],
    "verbatimModuleSyntax": false,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "prerender/**/*.ts", "vite.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

One tsconfig covers both the bundle and the Node build tooling; `dom` and `node` types coexist
without conflict, and the lint boundary (Task 16) is what actually keeps `node:*` out of `src/`.

- [ ] **Step 4: Create the shell and the Vite config**

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Keco — the Kubernetes ecosystem search engine</title>
    <meta
      name="description"
      content="Search the Kubernetes ecosystem: CLIs, kubectl plugins, operators, Helm charts and dashboards, classified and ranked by health rather than stars."
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

The prerender rewrites the `<title>`, the description and the `<div id="root">` of the *built*
copy of this file, and asserts each replacement applied — so editing those three lines means
checking `prerender/html.test.ts` still passes.

Create `apps/web/vite.config.ts`:

```typescript
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The portal is a static SPA (AGENTS.md §9): no SSR, no framework routing conventions. The
 * build output is a `dist/` folder that apps/api serves.
 *
 * In development the API runs separately on :3000 and this proxies `/api` to it, so client
 * code uses the same paths in both environments and never branches on a base URL.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The prerender writes into dist/prerendered afterwards; a later `vite build` clears it,
    // which is why `mise run build` always runs the two in that order.
    sourcemap: false,
  },
});
```

- [ ] **Step 5: Create the entry, the route tree and the not-found route**

Create `apps/web/src/app.tsx`:

```tsx
import { Route, Routes } from 'react-router';
import { NotFoundPage } from './routes/not-found';

/**
 * The route tree, and the one thing both `main.tsx` and `prerender/index.ts` import. Keeping
 * it in a single component is what makes the prerendered HTML and the client render the same
 * tree — a second, hand-written rendering of a page is a second thing to keep in sync (§9).
 *
 * Routes are added in Tasks 12–14.
 */
export function App() {
  return (
    <Routes>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
```

Create `apps/web/src/routes/not-found.tsx`:

```tsx
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main>
      <h1>Not found</h1>
      <p>
        That page does not exist. Try <Link to="/">the home page</Link> or{' '}
        <Link to="/search">search the ecosystem</Link>.
      </p>
    </main>
  );
}
```

Create `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

const tree = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

/**
 * Prerendered tool pages arrive with markup already inside #root and their data on
 * `window.__KECO_DATA__`, so React hydrates over what the crawler saw (§9). Every other route
 * gets the empty shell and mounts fresh. Calling hydrateRoot on an empty container logs a
 * mismatch, and createRoot on a filled one throws the prerendered HTML away — so the branch
 * is on the container, not on the route.
 */
if (container.firstChild) hydrateRoot(container, tree);
else createRoot(container).render(tree);
```

- [ ] **Step 6: Verify the build works**

Run: `pnpm install && pnpm -F @keco/web build && pnpm -F @keco/web check`
Expected: `vite build` writes `apps/web/dist/index.html` and a hashed JS asset; `tsc --noEmit`
prints nothing.

- [ ] **Step 7: Prove the taxonomy survives bundling**

This is the claim Task 1 made and the one thing about it a unit test cannot check.

Run: `grep -rc "cncf-graduated" apps/web/dist/assets/*.js`
Expected: at least one file reports a count ≥ 1 — the YAML was inlined by `?raw` and parsed
into the bundle.

Run: `grep -rn "node:fs\|readFileSync" apps/web/dist/assets/*.js`
Expected: no output. If anything matches, the `browser` field is not being applied and Task 1
is not finished.

*(The `App` component does not reference the taxonomy yet, so if the first grep finds nothing,
add `import '@keco/core';` to `main.tsx` temporarily to confirm, then remove it — Task 11 makes
the import real.)*

- [ ] **Step 8: Commit**

```bash
git add -A apps/web pnpm-lock.yaml
git commit -m "feat(web): replace Next.js with a Vite + React SPA shell

Deletes the App Router surface, next.config.ts and the two server-only lib
modules: the portal now queries Meilisearch from the browser (§9) and reads
READMEs through apps/api, because §7 bars a bundle from @keco/cache. Adds the
Vite config with an /api dev proxy, the route tree both the client and the
prerender import, and an entry that hydrates over prerendered markup."
```

---

## Task 11: The portal's data layer

Three small modules: a lazy Meilisearch client, the retrieval adapter over `@keco/core`'s algebra, and the prerender bootstrap channel. `topics.ts` moves across with one import changed.

**Files:**
- Create: `apps/web/src/lib/meili.ts`, `apps/web/src/lib/search.ts`, `apps/web/src/lib/bootstrap.ts`
- Modify: `apps/web/src/lib/topics.ts:2` (the import)
- Test: `apps/web/src/lib/topics.test.ts` (unchanged, must keep passing)

- [ ] **Step 1: Run the moved test to see where it stands**

Run: `pnpm vitest run apps/web/src/lib/topics.test.ts`
Expected: FAIL — `topics.ts` still imports `familyAttribute` and `paramForFamily` from
`@keco/query`, which `apps/web` no longer depends on at runtime.

- [ ] **Step 2: Repoint `topics.ts`**

In `apps/web/src/lib/topics.ts`, replace the two import lines at the top with one:

```typescript
import { facetableFamilies, family, familyAttribute, paramForFamily, values } from '@keco/core';
```

Nothing else in the file changes — it was already pure and taxonomy-driven.

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/topics.test.ts`
Expected: PASS — the same cases as before, now sourcing the algebra from `@keco/core`.

- [ ] **Step 4: Write the Meilisearch client**

Create `apps/web/src/lib/meili.ts`:

```typescript
import { TOOLS_INDEX, type ToolDocument } from '@keco/core';
import { Meilisearch, type Index } from 'meilisearch';

/**
 * Search is browser → Meilisearch, directly (AGENTS.md §9). No backend round-trip per
 * keystroke — that is the whole reason the search key is public.
 *
 * `VITE_`-prefixed variables are inlined into the shipped bundle at build time and are public
 * permanently (§12). The key here is search-only and scoped to `tools`; the master key lives
 * in apps/api's environment and never has that prefix.
 *
 * Built lazily rather than at module load, because `prerender/index.ts` imports this module's
 * consumers in Node, where `import.meta.env` does not exist and no query is ever issued.
 */
type ViteEnv = { VITE_MEILI_HOST?: string; VITE_MEILI_SEARCH_KEY?: string };

const viteEnv = (): ViteEnv => (import.meta as ImportMeta & { env?: ViteEnv }).env ?? {};

let client: Meilisearch | null = null;

export function searchClient(): Meilisearch {
  if (client) return client;
  const env = viteEnv();
  client = new Meilisearch({
    // `||` and not `??`: an unset variable is inlined as an empty string, not undefined.
    host: env.VITE_MEILI_HOST || 'http://localhost:7700',
    apiKey: env.VITE_MEILI_SEARCH_KEY || undefined,
  });
  return client;
}

export const toolsIndex = (): Index<ToolDocument> =>
  searchClient().index<ToolDocument>(TOOLS_INDEX);
```

- [ ] **Step 5: Write the retrieval adapter**

Create `apps/web/src/lib/search.ts`:

```typescript
import {
  buildFilters,
  defaultFacets,
  sortSpec,
  toDocumentId,
  type FacetSelection,
  type SortKey,
  type ToolDocument,
} from '@keco/core';
import { toolsIndex } from './meili';

/**
 * The portal's retrieval, and the counterpart to @keco/query on the API side.
 *
 * §11 says REST, MCP and chat are thin adapters over one implementation; §9 says the portal
 * queries Meilisearch directly with the search-only key, and §7 bars a browser bundle from
 * importing @keco/query. Both hold: the *algebra* — filters, facets, sorts, the URL-parameter
 * mapping — lives in @keco/core and is shared, and only the client differs. The algebra is
 * the part that can silently drift; a `.search()` call cannot.
 *
 * Every function here is one Meilisearch call. Anything that needs two belongs in a route.
 */
export type PortalSearchParams = {
  q?: string;
  filters?: FacetSelection;
  sort?: SortKey;
  page?: number;
  hitsPerPage?: number;
};

export type PortalSearchResult = {
  hits: ToolDocument[];
  total: number;
  page: number;
  facets: Record<string, Record<string, number>>;
  processingTimeMs: number;
};

export async function searchTools(params: PortalSearchParams = {}): Promise<PortalSearchResult> {
  const response = await toolsIndex().search(params.q ?? '', {
    filter: buildFilters({ filters: params.filters }),
    sort: sortSpec(params.sort),
    page: params.page ?? 1,
    hitsPerPage: params.hitsPerPage ?? 20,
    // Facet distribution is the only aggregation this system has (§5).
    facets: defaultFacets(),
  });

  return {
    hits: response.hits,
    total: response.totalHits ?? response.hits.length,
    page: response.page ?? 1,
    facets: response.facetDistribution ?? {},
    processingTimeMs: response.processingTimeMs,
  };
}

/**
 * The facet distribution for every family, with no hits: `hitsPerPage: 0` buys the counts the
 * Browse rows need and nothing else (§9).
 */
export async function browseFacets(): Promise<Record<string, Record<string, number>>> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({}),
    facets: defaultFacets(),
    hitsPerPage: 0,
  });
  return response.facetDistribution ?? {};
}

/**
 * "Momentum", never "trending this week" (§4.4). With no history there is no honest star
 * velocity, and the UI must not pretend otherwise.
 */
export async function whatsHot(limit = 12): Promise<ToolDocument[]> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({}),
    sort: sortSpec('momentum'),
    hitsPerPage: limit,
  });
  return response.hits;
}

/** `owner/repo` is the public identifier; the document id is an internal detail (§11). */
export async function getTool(fullName: string): Promise<ToolDocument | null> {
  try {
    return await toolsIndex().getDocument(toDocumentId(fullName));
  } catch {
    return null;
  }
}

/**
 * Same kind, overlapping domains, ranked by score, excluding the same owner so a monorepo
 * family does not fill the list (§9).
 */
export async function findAlternatives(tool: ToolDocument, limit = 6): Promise<ToolDocument[]> {
  const response = await toolsIndex().search('', {
    filter: buildFilters({ filters: { kind: [tool.kind], domains: tool.domains } }),
    sort: sortSpec('score'),
    hitsPerPage: limit + 10,
  });
  return response.hits
    .filter((hit) => hit.full_name !== tool.full_name && hit.owner !== tool.owner)
    .slice(0, limit);
}
```

- [ ] **Step 6: Write the bootstrap channel**

Create `apps/web/src/lib/bootstrap.ts`:

```typescript
import type { ToolDocument } from '@keco/core';

/**
 * The channel the prerender uses to hand a page its data (AGENTS.md §9).
 *
 * At build time `prerender/index.ts` calls `setBootstrap()` before `renderToString`, so the
 * component tree renders with real content. At runtime the same page arrives with that data
 * serialised into `window.__KECO_DATA__`, so the client's first render matches the markup it
 * is hydrating over. Any other route reads an empty object and fetches for itself.
 */
export type Bootstrap = { tool?: ToolDocument };

declare global {
  interface Window {
    __KECO_DATA__?: Bootstrap;
  }
}

/** Set only by the prerender, which is single-threaded and renders one page at a time. */
let injected: Bootstrap | null = null;

export const setBootstrap = (data: Bootstrap | null): void => {
  injected = data;
};

export function readBootstrap(): Bootstrap {
  if (injected) return injected;
  return typeof window === 'undefined' ? {} : (window.__KECO_DATA__ ?? {});
}
```

- [ ] **Step 7: Verify**

Run: `pnpm vitest run apps/web && pnpm -F @keco/web check && pnpm -F @keco/web build`
Expected: PASS — `topics.test.ts` green, typecheck silent, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib
git commit -m "feat(web): the portal's browser data layer

A lazy Meilisearch client on the search-only key, a retrieval adapter built on
the filter algebra now in @keco/core, and the bootstrap channel the prerender
hands page data through. topics.ts changes one import and keeps its test.

The portal and the API share the algebra, not the client — which is the part that
can drift (AGENTS.md §7, §9, §11)."
```

---

## Task 12: The home route

Hero search, the Browse chip rows built from the facet distribution, and Highest momentum. Ports `(portal)/page.tsx` and `topic-chips.tsx`.

**Files:**
- Create: `apps/web/src/routes/home.tsx`, `apps/web/src/components/topic-chips.tsx`
- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: Create the chip component**

Create `apps/web/src/components/topic-chips.tsx` — the Next version with `next/link` swapped
for `react-router`'s:

```tsx
import { Link } from 'react-router';
import type { ChipRow } from '../lib/topics';

/**
 * Browse-by-topic rows (AGENTS.md §9). Plain links, which is what makes the rows crawlable
 * and what keeps them working before the JS bundle has loaded.
 *
 * A value with no documents behind it renders no chip, so this renders nothing at all until
 * the first crawl fills the index — no dead links, no wall of zero-count chips.
 */
export function TopicChips({ rows }: { rows: ChipRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="browse">
      <h2 id="browse">Browse</h2>
      {rows.map((row) => (
        <nav key={row.familyId} aria-label={row.label}>
          <h3>{row.label}</h3>
          <ul>
            {row.chips.map((chip) => (
              <li key={chip.id}>
                <Link to={chip.href} title={chip.description}>
                  {chip.label} <span aria-label={`${chip.count} tools`}>{chip.count}</span>
                </Link>
              </li>
            ))}
            {row.moreHref && (
              <li>
                <Link to={row.moreHref}>more →</Link>
              </li>
            )}
          </ul>
        </nav>
      ))}
    </section>
  );
}
```

- [ ] **Step 2: Create the home route**

Create `apps/web/src/routes/home.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { TopicChips } from '../components/topic-chips';
import { browseFacets, whatsHot } from '../lib/search';
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
  const [hot, setHot] = useState<ToolDocument[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([browseFacets(), whatsHot(12)])
      .then(([facets, tools]) => {
        if (cancelled) return;
        setRows(chipRows(facets));
        setHot(tools);
      })
      // A blank SPA tells the reader nothing. Say what failed (§9 empty states).
      .catch(() => !cancelled && setError('Search is unavailable right now.'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Keco</h1>
      <p>Find the right Kubernetes tool in 10 seconds, not 10 browser tabs.</p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const q = new FormData(event.currentTarget).get('q');
          void navigate(`/search?q=${encodeURIComponent(typeof q === 'string' ? q : '')}`);
        }}
      >
        <label htmlFor="q">Search the Kubernetes ecosystem</label>
        <input id="q" name="q" type="search" placeholder="ingress controller, cost, backup…" />
        <button type="submit">Search</button>
      </form>

      {error && <p role="alert">{error}</p>}

      {/* Renders nothing until the first crawl has filled the index. */}
      <TopicChips rows={rows} />

      {hot.length > 0 && (
        <>
          {/* "Momentum", never "trending this week": there is no history to measure (§4.4). */}
          <h2>Highest momentum</h2>
          <ul>
            {hot.map((tool) => (
              <li key={tool.id}>
                <Link to={`/tools/${tool.full_name}`}>{tool.full_name}</Link> — {tool.summary}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Register the route**

In `apps/web/src/app.tsx`, add the import and the route above the catch-all:

```tsx
      <Route path="/" element={<HomePage />} />
```

- [ ] **Step 4: Verify**

Run: `pnpm -F @keco/web check && pnpm -F @keco/web build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): port the home route

Hero search, Browse chip rows from the facet distribution, and Highest momentum
— all from browser-direct Meilisearch queries. A failed query says so rather than
rendering a blank page (AGENTS.md §9)."
```

---

## Task 13: The search route

URL-synced state, so results are shareable and back/forward work. Ports `(portal)/search/page.tsx`.

**Files:**
- Create: `apps/web/src/routes/search.tsx`
- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: Create the route**

Create `apps/web/src/routes/search.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isSortKey, selectionFromParams } from '@keco/core';
import { searchTools, type PortalSearchResult } from '../lib/search';

/**
 * Search (AGENTS.md §9). State lives in the URL (`?q=&kind=&domain=&install=&sort=&view=`) so
 * results are shareable and back/forward work — `useSearchParams` is the only state store on
 * this page, deliberately.
 *
 * Every taxonomy family is readable from the URL by its declared `param`
 * (`selectionFromParams`), so adding a family needs no change here (§6).
 *
 * The facet sidebar, list/grid toggle and keyboard navigation are ROADMAP v1 items; this is
 * the ported baseline, not the finished page.
 */
const DEBOUNCE_MS = 80;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [results, setResults] = useState<PortalSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  // The URL is untrusted input: narrow it rather than casting (§14).
  const key = params.toString();

  useEffect(() => {
    let cancelled = false;
    // ~80 ms, so search-as-you-type does not issue a query per keystroke (§9).
    const timer = setTimeout(() => {
      searchTools({
        q,
        filters: selectionFromParams(params),
        sort: isSortKey(sort) ? sort : 'relevance',
        page,
      })
        .then((next) => !cancelled && (setResults(next), setError(null)))
        .catch(() => !cancelled && setError('Search is unavailable right now.'));
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` is the whole URL query: one dependency that changes exactly when a query should
    // be re-issued, and never when an unrelated re-render happens.
  }, [key]);

  return (
    <main>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('q');
          const next = new URLSearchParams(params);
          next.set('q', typeof value === 'string' ? value : '');
          next.delete('page');
          setParams(next);
        }}
      >
        <input name="q" type="search" defaultValue={q} aria-label="Search" />
        <button type="submit">Search</button>
      </form>

      {error && <p role="alert">{error}</p>}

      {results && (
        <>
          <p>
            {results.total} tools · {results.processingTimeMs} ms
          </p>

          {results.total === 0 && (
            // Empty and zero-result states must suggest something useful (§9).
            <section>
              <h2>No matches</h2>
              <p>
                Try a broader term, or browse by <Link to="/search?kind=operator">operators</Link>,{' '}
                <Link to="/search?domain=observability">observability</Link> or{' '}
                <Link to="/search?install=krew">kubectl plugins</Link>.
              </p>
            </section>
          )}

          <ul>
            {results.hits.map((tool) => (
              <li key={tool.id}>
                <Link to={`/tools/${tool.full_name}`}>{tool.full_name}</Link>
                <p>{tool.summary}</p>
                <small>
                  {tool.kind} · {tool.domains.join(', ')} · ★ {tool.stars}
                  {tool.archived && ' · archived'}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Register the route**

In `apps/web/src/app.tsx`, add above the catch-all:

```tsx
      <Route path="/search" element={<SearchPage />} />
```

- [ ] **Step 3: Verify**

Run: `pnpm -F @keco/web check && pnpm -F @keco/web build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): port the search route

URL-synced state via useSearchParams, so results stay shareable and back/forward
work. Facets are read from their declared taxonomy params and ?sort= is narrowed
rather than cast. 80 ms debounce on the browser-direct query (AGENTS.md §9)."
```

---

## Task 14: The tool route

The SEO surface, and the only page the prerender emits. It renders from bootstrap data when prerendered, fetches when not, and upgrades the README excerpt to the full sanitised HTML client-side.

**Files:**
- Create: `apps/web/src/routes/tool.tsx`
- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: Create the route**

Create `apps/web/src/routes/tool.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ToolDocument } from '@keco/core';
import { readBootstrap } from '../lib/bootstrap';
import { findAlternatives, getTool } from '../lib/search';
import { NotFoundPage } from './not-found';

/**
 * Tool page — the SEO surface (AGENTS.md §9), and the one route the prerender emits as static
 * HTML. Everything above the README is rendered from the `tools` document alone, which is why
 * the prerendered file carries real content without touching the cache.
 *
 * The README is a two-stage thing on purpose. `readme_excerpt` ships inside the document, so
 * it is in the prerendered HTML a crawler reads. The full README lives in the cache, which a
 * browser cannot read, so it arrives from `GET /api/readme/:owner/:repo` — already sanitised
 * server-side, which is the only reason the HTML below is injected at all (§9, §14).
 */
type ReadmeResponse = { repo: string; html: string };

export function ToolPage() {
  const { owner, repo } = useParams<{ owner: string; repo: string }>();
  const fullName = `${owner}/${repo}`;

  // Prerendered pages already have the document; only a client-side navigation fetches it.
  const [tool, setTool] = useState<ToolDocument | null>(() => readBootstrap().tool ?? null);
  const [loading, setLoading] = useState(tool === null);
  const [related, setRelated] = useState<ToolDocument[]>([]);
  const [readmeHtml, setReadmeHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (tool?.full_name === fullName) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getTool(fullName)
      .then((next) => {
        if (cancelled) return;
        setTool(next);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fullName]);

  useEffect(() => {
    if (!tool) return;
    let cancelled = false;

    void findAlternatives(tool, 6).then((next) => !cancelled && setRelated(next));

    fetch(`/api/readme/${tool.full_name}`)
      .then((response) => (response.ok ? (response.json() as Promise<ReadmeResponse>) : null))
      .then((body) => !cancelled && setReadmeHtml(body?.html ?? null))
      // No cached README is an ordinary state before the crawler reaches a repo, not an error.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [tool?.full_name]);

  if (loading) return <main aria-busy="true">Loading {fullName}…</main>;
  if (!tool) return <NotFoundPage />;

  return (
    <main>
      <h1>{tool.full_name}</h1>
      <p>{tool.summary}</p>

      <section>
        <h2>Install</h2>
        {tool.install_methods.length === 0 ? (
          // Unprovable ⇒ not listed. A wrong `brew install` line is the worst bug this
          // project can ship — people paste these into a terminal (§6).
          <p>No install method verified against a registry.</p>
        ) : (
          <ul>
            {tool.install_methods.map((method) => (
              <li key={method.method}>
                <code>{method.command}</code>{' '}
                <a href={method.source_url} rel="noreferrer">
                  proof
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Health</h2>
        <dl>
          <dt>Score</dt>
          <dd>{tool.score.total.toFixed(2)}</dd>
          <dt>Quality coverage</dt>
          {/* 0.9 from four signals and 0.9 from one are not the same claim (§4.3). */}
          <dd>{Math.round(tool.score.quality_coverage * 100)}% of signals present</dd>
          <dt>Momentum</dt>
          <dd>{tool.score.momentum.toFixed(2)}</dd>
        </dl>
      </section>

      <aside>
        <ul>
          <li>★ {tool.stars}</li>
          <li>{tool.language ?? 'unknown language'}</li>
          <li>{tool.license ?? 'no license'}</li>
          <li>Last commit {new Date(tool.pushed_at).toDateString()}</li>
          <li>
            <a href={tool.repo_url} rel="noreferrer">
              Source on GitHub
            </a>
          </li>
        </ul>
      </aside>

      <section>
        <h2>README</h2>
        {readmeHtml === null ? (
          // The excerpt is in the document, so it is in the prerendered HTML too — this is the
          // indexable prose on the page until the full README arrives.
          <p>{tool.readme_excerpt}</p>
        ) : (
          // Sanitised by apps/api with rehype-sanitize before it ever reached the browser
          // (§9, §14). Never do this to raw markdown output.
          <div dangerouslySetInnerHTML={{ __html: readmeHtml }} />
        )}
      </section>

      {related.length > 0 && (
        <section>
          <h2>Related</h2>
          <ul>
            {related.map((other) => (
              <li key={other.id}>
                <Link to={`/tools/${other.full_name}`}>{other.full_name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer>Data from GitHub, updated {new Date(tool.indexed_at).toISOString()}.</footer>
    </main>
  );
}
```

- [ ] **Step 2: Register the route**

In `apps/web/src/app.tsx`, add above the catch-all:

```tsx
      <Route path="/tools/:owner/:repo" element={<ToolPage />} />
```

The finished `app.tsx` route list is, in order: `/`, `/search`, `/tools/:owner/:repo`, `*`.

- [ ] **Step 3: Verify**

Run: `pnpm -F @keco/web check && pnpm -F @keco/web build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): port the tool route

Renders from prerender bootstrap data when present and fetches otherwise, so the
same component serves the static HTML and a client-side navigation. readme_excerpt
is the indexable prose; the full sanitised README arrives from /api/readme
(AGENTS.md §9, §14)."
```

---

## Task 15: The build-time prerender

§9 is explicit that this is not optional: a bare SPA is not indexable enough for a portal whose acquisition channel is organic search. The HTML assembly is a pure function so it can be tested; the script around it is I/O.

**Files:**
- Create: `apps/web/prerender/html.ts`, `apps/web/prerender/html.test.ts`, `apps/web/prerender/index.ts`
- Modify: `vitest.config.ts` (include the new directory)

- [ ] **Step 1: Let vitest see the directory**

In `vitest.config.ts`, extend `include`:

```typescript
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/prerender/**/*.test.ts',
    ],
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/prerender/html.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { ToolDocument } from '@keco/core';
import { robotsTxt, sitemapXml, toolPageHtml } from './html';

const SHELL = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <title>Keco — the Kubernetes ecosystem search engine</title>',
  '    <meta name="description" content="Search the Kubernetes ecosystem." />',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '    <script type="module" src="/assets/main-abc123.js"></script>',
  '  </body>',
  '</html>',
].join('\n');

const tool = {
  id: 'ahmetb__kubectx',
  owner: 'ahmetb',
  name: 'kubectx',
  full_name: 'ahmetb/kubectx',
  description: 'Faster way to switch between clusters and namespaces in kubectl',
  summary: 'Fast context and namespace switching for kubectl.',
  repo_url: 'https://github.com/ahmetb/kubectx',
  homepage: null,
  license: 'Apache-2.0',
  stars: 18000,
  kind: 'cli',
  domains: ['dev-experience'],
  readme_excerpt: 'kubectx is a tool to switch between contexts in your kubeconfig.',
  indexed_at: '2026-08-18T00:00:00.000Z',
} as unknown as ToolDocument;

const html = toolPageHtml(SHELL, { tool, markup: '<main><h1>ahmetb/kubectx</h1></main>', siteUrl: 'https://keco.dev' });

describe('toolPageHtml', () => {
  it('puts the tool in the title', () => {
    expect(html).toContain('<title>ahmetb/kubectx · Keco</title>');
    expect(html).not.toContain('the Kubernetes ecosystem search engine</title>');
  });

  it('replaces the shell meta description with the tool summary', () => {
    expect(html).toContain('content="Fast context and namespace switching for kubectl."');
    expect(html).not.toContain('content="Search the Kubernetes ecosystem."');
  });

  it('inlines the rendered markup inside #root so a crawler sees an h1', () => {
    expect(html).toContain('<div id="root"><main><h1>ahmetb/kubectx</h1></main></div>');
  });

  it('emits a canonical link', () => {
    expect(html).toContain('<link rel="canonical" href="https://keco.dev/tools/ahmetb/kubectx"');
  });

  it('emits JSON-LD describing a SoftwareApplication', () => {
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const jsonLd = JSON.parse(match![1]!);
    expect(jsonLd['@type']).toBe('SoftwareApplication');
    expect(jsonLd.name).toBe('ahmetb/kubectx');
    expect(jsonLd.codeRepository).toBe('https://github.com/ahmetb/kubectx');
  });

  it('embeds the document so the client hydrates over matching markup', () => {
    expect(html).toContain('window.__KECO_DATA__=');
    expect(html).toContain('ahmetb/kubectx');
  });

  it('escapes a closing script tag in the embedded data', () => {
    // A summary containing </script> would otherwise break out of the script element and
    // become markup — the corpus is derived from 30k strangers' repositories.
    const hostile = { ...tool, summary: 'ends the tag </script><img src=x onerror=alert(1)>' };
    const output = toolPageHtml(SHELL, { tool: hostile, markup: '', siteUrl: 'https://keco.dev' });
    expect(output).not.toContain('</script><img');
    expect(output).toContain('\\u003c/script');
  });

  it('escapes quotes in the meta description', () => {
    const quoted = { ...tool, summary: 'a "quoted" summary' };
    const output = toolPageHtml(SHELL, { tool: quoted, markup: '', siteUrl: 'https://keco.dev' });
    expect(output).toContain('&quot;quoted&quot;');
  });

  it('throws when the shell no longer contains what it replaces', () => {
    // A silent no-op here ships a portal Google cannot read, which §9 calls a blocking
    // regression. Fail the build instead.
    expect(() =>
      toolPageHtml('<html><head></head><body></body></html>', {
        tool,
        markup: '',
        siteUrl: 'https://keco.dev',
      }),
    ).toThrow(/shell/i);
  });
});

describe('sitemapXml', () => {
  it('lists the home page and every prerendered tool', () => {
    const xml = sitemapXml('https://keco.dev', [tool]);
    expect(xml).toContain('<loc>https://keco.dev</loc>');
    expect(xml).toContain('<loc>https://keco.dev/tools/ahmetb/kubectx</loc>');
    expect(xml).toContain('<lastmod>2026-08-18T00:00:00.000Z</lastmod>');
  });

  it('is valid XML with a single urlset root', () => {
    const xml = sitemapXml('https://keco.dev', []);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml.match(/<urlset/g)).toHaveLength(1);
  });
});

describe('robotsTxt', () => {
  it('points at the sitemap and keeps /admin out of the index', () => {
    const txt = robotsTxt('https://keco.dev');
    expect(txt).toContain('Sitemap: https://keco.dev/sitemap.xml');
    expect(txt).toContain('Disallow: /admin');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/web/prerender/html.test.ts`
Expected: FAIL — `Failed to resolve import "./html"`.

- [ ] **Step 4: Write `apps/web/prerender/html.ts`**

```typescript
import type { ToolDocument } from '@keco/core';

/**
 * Pure assembly of the prerendered artifacts (AGENTS.md §9). No I/O and no React, so it is
 * testable on a fixture document — `index.ts` does the querying, rendering and writing.
 *
 * Every substitution is asserted. A shell edit that silently stops matching would ship tool
 * pages with an empty `#root` and the generic title, which is exactly the blocking SEO
 * regression §9 describes; failing the build is the only acceptable behaviour.
 */
const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, '&quot;');

/**
 * Serialises data for an inline `<script>`. The corpus is derived from 30k strangers'
 * repositories, so a summary containing `</script>` must not be able to close the element.
 */
const serialize = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

/** Replaces `pattern` exactly once, or throws — a silent miss is a shipped regression. */
function replaceOnce(html: string, pattern: RegExp | string, replacement: string, what: string): string {
  const next = html.replace(pattern, () => replacement);
  if (next === html) {
    throw new Error(
      `prerender: the built shell no longer contains ${what}. index.html and prerender/html.ts have to agree — see AGENTS.md §9.`,
    );
  }
  return next;
}

export type ToolPageOptions = {
  tool: ToolDocument;
  /** `renderToString` output for this route. */
  markup: string;
  siteUrl: string;
};

export function toolPageHtml(shell: string, options: ToolPageOptions): string {
  const { tool, markup, siteUrl } = options;
  const url = `${siteUrl}/tools/${tool.full_name}`;
  const description = truncate(tool.summary || tool.description || `${tool.full_name} on Keco`, 155);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: tool.full_name,
    description: tool.summary,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Linux, macOS, Windows',
    url,
    codeRepository: tool.repo_url,
    license: tool.license,
    // Eventual consistency is the contract; freshness is published, not hidden (§2.7).
    dateModified: tool.indexed_at,
  };

  const head = [
    `<link rel="canonical" href="${escapeAttribute(url)}" />`,
    `<script type="application/ld+json">${serialize(jsonLd)}</script>`,
    // Read by src/lib/bootstrap.ts, so the client's first render matches this markup.
    `<script>window.__KECO_DATA__=${serialize({ tool })}</script>`,
  ].join('\n    ');

  let html = replaceOnce(
    shell,
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeText(`${tool.full_name} · Keco`)}</title>`,
    'a <title> element',
  );
  html = replaceOnce(
    html,
    /<meta\s+name="description"[\s\S]*?\/?>/,
    `<meta name="description" content="${escapeAttribute(description)}" />`,
    'a <meta name="description"> element',
  );
  html = replaceOnce(html, '</head>', `  ${head}\n  </head>`, 'a </head> tag');
  html = replaceOnce(
    html,
    '<div id="root"></div>',
    `<div id="root">${markup}</div>`,
    'an empty <div id="root">',
  );

  return html;
}

export function sitemapXml(siteUrl: string, tools: ToolDocument[]): string {
  const entries = tools
    .map(
      (tool) =>
        `  <url>\n    <loc>${escapeText(`${siteUrl}/tools/${tool.full_name}`)}</loc>\n    <lastmod>${escapeText(tool.indexed_at)}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`,
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url>\n    <loc>${escapeText(siteUrl)}</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    entries,
    '</urlset>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** /admin is noindex and never prerendered (§9). */
export const robotsTxt = (siteUrl: string): string =>
  ['User-agent: *', 'Allow: /', 'Disallow: /admin', '', `Sitemap: ${siteUrl}/sitemap.xml`, ''].join('\n');
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/prerender/html.test.ts`
Expected: PASS — 13 cases green.

- [ ] **Step 6: Write the prerender script**

Create `apps/web/prerender/index.ts`:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { createQueryClient, searchTools } from '@keco/query';
import { App } from '../src/app';
import { setBootstrap } from '../src/lib/bootstrap';
import { robotsTxt, sitemapXml, toolPageHtml } from './html';

/**
 * Build-time prerender (AGENTS.md §9). Dropping Next.js dropped server rendering, and a bare
 * SPA is not indexable enough for a portal whose acquisition channel is organic search — so
 * this is not optional, and a change that makes the top tool pages non-prerenderable is a
 * blocking regression.
 *
 * It reads the read model and nothing else. No cache, no GitHub, no running API: the README
 * that ends up in each page is `readme_excerpt`, which is already inside the `tools`
 * document. The full README is fetched client-side from apps/api.
 *
 * `renderToString` runs the same route tree the browser mounts, so what a crawler sees and
 * what a reader sees cannot drift.
 *
 * Prerendered HTML is exactly as stale as the last build; rebuild on the projector's full
 * rebuild cadence and keep `indexed_at` visible so the staleness stays honest.
 */
const TOP_N = 1000;

const dist = resolve(import.meta.dirname, '..', 'dist');
const siteUrl = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const shell = await readFile(join(dist, 'index.html'), 'utf8').catch(() => {
  throw new Error(`prerender: ${join(dist, 'index.html')} not found — run \`vite build\` first.`);
});

// Meilisearch being unreachable fails the build. An empty index does not: before the first
// crawl there is genuinely nothing to prerender, and that is a true state of the system.
const client = createQueryClient();
const top = await searchTools(client, { sort: 'score', hitsPerPage: TOP_N });

for (const tool of top.hits) {
  // Single-threaded, one page at a time: the component tree reads this through readBootstrap().
  setBootstrap({ tool });
  const markup = renderToString(
    createElement(StaticRouter, { location: `/tools/${tool.full_name}` }, createElement(App)),
  );
  setBootstrap(null);

  const file = join(dist, 'prerendered', 'tools', `${tool.full_name}.html`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, toolPageHtml(shell, { tool, markup, siteUrl }), 'utf8');
}

await writeFile(join(dist, 'sitemap.xml'), sitemapXml(siteUrl, top.hits), 'utf8');
await writeFile(join(dist, 'robots.txt'), robotsTxt(siteUrl), 'utf8');
// apps/api loads this at boot and serves a prerendered file only for a path it lists.
await writeFile(
  join(dist, 'prerender-manifest.json'),
  `${JSON.stringify({ paths: top.hits.map((tool) => `/tools/${tool.full_name}`) }, null, 2)}\n`,
  'utf8',
);

console.log(`prerender: ${top.hits.length} tool pages, sitemap and robots.txt → ${dist}`);
```

- [ ] **Step 7: Verify against an empty index**

Meilisearch must be running; the index may be empty.

Run: `mise run infra:up && pnpm -F @keco/web build && pnpm -F @keco/web prerender`
Expected: `prerender: 0 tool pages, sitemap and robots.txt → …/apps/web/dist`, exit code 0,
and `apps/web/dist/sitemap.xml`, `robots.txt` and `prerender-manifest.json` all exist. An empty
corpus is a valid state, not a failure.

Run: `cat apps/web/dist/robots.txt`
Expected: contains `Disallow: /admin` and the `Sitemap:` line.

- [ ] **Step 8: Verify the build fails loudly when Meilisearch is unreachable**

Run: `MEILI_HOST=http://localhost:9 pnpm -F @keco/web prerender; echo "exit=$?"`
Expected: a connection error and `exit=1`. A portal that silently ships without its SEO
surface is the regression §9 warns about.

- [ ] **Step 9: Commit**

```bash
git add apps/web/prerender vitest.config.ts
git commit -m "feat(web): build-time prerender, sitemap and robots.txt

renderToString over the same route tree the browser mounts, so crawler HTML and
reader HTML cannot drift. Reads only the read model — readme_excerpt is already
in the tools document, so no cache access and no running API. Every shell
substitution is asserted, because a silent miss ships a portal Google cannot read
(AGENTS.md §9)."
```

---

## Task 16: Restate the §7 import boundaries in lint

The current `apps/web` rule forbids three write-side packages. A browser bundle needs a strictly stronger rule, `apps/web/prerender` needs a different one, and `apps/api` has no rule at all.

**Files:**
- Modify: `eslint.config.mjs`

- [ ] **Step 1: Replace the `apps/web` block**

In `eslint.config.mjs`, delete the existing `apps/web` config object and add these three in its
place, keeping the `packages/query`, workers and `packages/signals` blocks as they are:

```javascript
  // The portal bundle ships to strangers. Anything it imports is public, so the rule is not
  // "no write-side packages" but "@keco/core and meilisearch, and nothing else" (§7).
  // @keco/query and @keco/search are read-side and harmless in themselves, but @keco/search
  // carries createAdminClient, which reads MEILI_MASTER_KEY — a bundle must not be one
  // tree-shaking mistake away from that.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: boundary(
      'apps/web/src is a browser bundle: @keco/core and meilisearch only, and no node:* (§7).',
      [
        ['@keco/cache', '@keco/cache/*', '@keco/github', '@keco/signals', '@keco/analyze'],
        ['@keco/query', '@keco/search'],
        ['node:*', 'fs', 'path', 'crypto', 'os'],
      ],
    ),
  },

  // Not bundle code: this is Node build tooling that reads the read model and writes files.
  // It may hold a query client; it still may not touch the write side.
  {
    files: ['apps/web/prerender/**/*.ts'],
    rules: boundary(
      'apps/web/prerender is build tooling: it may read the read model, never the write side (§7).',
      [['@keco/cache', '@keco/cache/*', '@keco/github', '@keco/signals', '@keco/analyze']],
    ),
  },

  // The API reads Meilisearch and the cache by key. It never fetches from a third party —
  // that is the write side's job, and its quota.
  {
    files: ['apps/api/**/*.ts'],
    rules: boundary(
      'apps/api may import @keco/query, @keco/core, @keco/cache and @keco/search — never a write-side fetcher (§7).',
      [['@keco/github', '@keco/signals', '@keco/analyze']],
    ),
  },
```

- [ ] **Step 2: Drop the stale ignore**

In the `ignores` array, delete `'**/.next/**'` — there is no Next build output any more.

- [ ] **Step 3: Verify the rules actually bite**

Deliberate violations, exactly as §7's existing rules were proven:

```bash
echo "import { createCacheFromEnv } from '@keco/cache';
console.log(createCacheFromEnv);" > apps/web/src/lib/violation.ts
pnpm eslint apps/web/src/lib/violation.ts
```
Expected: an error naming the browser-bundle rule.

```bash
echo "import { readFile } from 'node:fs/promises';
console.log(readFile);" > apps/web/src/lib/violation.ts
pnpm eslint apps/web/src/lib/violation.ts
```
Expected: an error on the `node:*` group.

```bash
echo "import { Octokit } from '@keco/github';
console.log(Octokit);" > apps/api/src/violation.ts
pnpm eslint apps/api/src/violation.ts
```
Expected: an error naming the apps/api rule.

```bash
rm apps/web/src/lib/violation.ts apps/api/src/violation.ts
```

- [ ] **Step 4: Run lint over the real tree**

Run: `pnpm eslint .`
Expected: no errors. If `apps/web/prerender/index.ts` is flagged, the `files` glob is wrong —
it must not be caught by the `apps/web/src/**` block.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs
git commit -m "chore(lint): restate the §7 boundaries for the new read side

apps/web/src is a browser bundle — @keco/core and meilisearch only, and no
node:*, which is strictly stronger than the rule it replaces. apps/web/prerender
is Node build tooling and may hold a query client. apps/api gets the rule it
never had. Drops the .next ignore."
```

---

## Task 17: Environment, tasks and workspace config

**Files:**
- Modify: `.env.example`, `mise.toml`, `package.json`, `pnpm-workspace.yaml`, `.gitignore`

- [ ] **Step 1: Rewrite the read-side sections of `.env.example`**

Replace the `Meilisearch` and `Backoffice auth` sections, and add a portal section. The GitHub,
cache, workers and AI sections are unchanged:

```bash
# ── Meilisearch (read models) ────────────────────────────────────────────────
MEILI_HOST=http://localhost:7700
# Server-side only: the projector (write) and apps/api (read). Never sent to a browser.
MEILI_MASTER_KEY=keco-dev-master-key

# ── Portal bundle — apps/web ─────────────────────────────────────────────────
# Vite inlines every VITE_-prefixed variable into the shipped bundle at build time. Anything
# with this prefix is public, permanently, in every deployed artifact — never prefix a secret,
# and rotating one of these means a rebuild and a redeploy (§12).
# Search-only key, scoped to the `tools` index.
VITE_MEILI_HOST=http://localhost:7700
VITE_MEILI_SEARCH_KEY=

# ── apps/api ─────────────────────────────────────────────────────────────────
PORT=3000
HOST=0.0.0.0
# Absolute base for canonical links and the sitemap. Read by the prerender too.
SITE_URL=http://localhost:3000
# Where `vite build` put the portal; served by @fastify/static.
WEB_DIST=apps/web/dist

# ── Backoffice auth — apps/api admin routes only ─────────────────────────────
# Signs the admin session cookie. 32 characters minimum.
SESSION_SECRET=
# scrypt$<salt>$<key> — generate with: mise run admin:hash -- --password 'your-password'
ADMIN_PASSWORD_HASH=
# Bearer token accepted by /api/commands/* in place of an admin session.
COMMAND_TOKEN=
```

Delete `NEXT_PUBLIC_MEILI_HOST`, `NEXT_PUBLIC_MEILI_SEARCH_KEY`, `AUTH_SECRET`,
`AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` and `ADMIN_LOGINS` — the Auth.js design they belonged to
is gone (§12).

- [ ] **Step 2: Apply the same edits to your local `.env`**

`.env` is gitignored and will not be updated by the previous step.

Run: `grep -n "NEXT_PUBLIC\|AUTH_\|ADMIN_LOGINS" .env`
Expected: the stale variables. Replace them with the block above, filling in `SESSION_SECRET`
with 32+ characters. Then confirm nothing stale remains:

Run: `grep -c "NEXT_PUBLIC" .env; echo "exit=$?"`
Expected: `0`.

- [ ] **Step 3: Rewrite the read-side tasks in `mise.toml`**

Replace the `[tasks.dev]` and `[tasks.build]` blocks with:

```toml
[tasks.web]
description = "Portal dev server (Vite) on :5173, proxying /api to :3000"
run = "pnpm -F @keco/web dev"

[tasks.api]
description = "Fastify API + static portal on :3000"
run = "pnpm -F @keco/api dev"

[tasks.dev]
description = "Portal (:5173) and API (:3000) together"
# depends runs these in parallel; `run` would chain them and the first would never exit.
depends = ["web", "api"]

[tasks.prerender]
description = "Emit static tool pages, sitemap.xml and robots.txt from the read model"
run = "pnpm -F @keco/web prerender"

[tasks.build]
description = "Build the portal, prerender the top tool pages, typecheck the API"
# Order matters: `vite build` empties dist/, which would delete a previous prerender.
run = [
  "pnpm -F @keco/web build",
  "pnpm -F @keco/web prerender",
  "pnpm -F @keco/api check",
]

[tasks."admin:hash"]
description = "Hash a password for ADMIN_PASSWORD_HASH. Args: --password 'secret'"
run = "pnpm -F @keco/api admin:hash"
```

In the `[env]` block, replace the `NODE_ENV` comment — it exists only because of `next build`:

```toml
# NODE_ENV is deliberately not set here. Vite and Fastify each set their own (vite dev →
# development, vite build → production), and exporting one globally overrides both.
#
# Loaded from .env when present (created by `mise run setup`).
```

The rest of that comment, about `redact` and per-key redaction, stays as it is.

- [ ] **Step 4: Update the root `package.json` scripts**

```json
  "scripts": {
    "dev": "pnpm -F @keco/api dev",
    "build": "pnpm -F @keco/web build && pnpm -F @keco/web prerender",
    "check": "pnpm -r --parallel check",
    "lint": "eslint .",
    "test": "vitest run",
    "search:settings": "pnpm -F @keco/search settings"
  },
```

- [ ] **Step 5: Drop the Next-only build allowance**

In `pnpm-workspace.yaml`, remove the `sharp: true` line and fix the comment above it:

```yaml
# esbuild powers tsx/vitest. unrs-resolver is not needed.
allowBuilds:
  esbuild: true
  unrs-resolver: false
```

- [ ] **Step 6: Update `.gitignore`**

Run: `grep -n "next\|dist" .gitignore`
Replace any `.next` entry with `dist/`, so the Vite output and the prerendered files stay out
of git. Keep every other entry.

- [ ] **Step 7: Verify the toolchain end to end**

```bash
pnpm install
mise run ci
mise run build
```
Expected: `mise run ci` green (check, lint, test, taxonomy:check), and `mise run build`
producing `apps/web/dist` with `index.html`, `sitemap.xml`, `robots.txt` and
`prerender-manifest.json`.

Then, with Meilisearch up, confirm the two processes serve together:

```bash
mise run api &
sleep 2
curl -s localhost:3000/api/health
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/tools/anything/at-all
kill %1
```
Expected: `{"status":"ok"}` and `200` — the deep link falls back to the SPA shell, which is the
§14 behaviour a client-side route depends on.

- [ ] **Step 8: Commit**

```bash
git add .env.example mise.toml package.json pnpm-workspace.yaml .gitignore
git commit -m "chore: reconcile env, tasks and workspace config with the new read side

VITE_ replaces NEXT_PUBLIC_; ADMIN_PASSWORD_HASH and SESSION_SECRET replace the
Auth.js variables. mise gains web/api/prerender tasks, dev runs the two in
parallel, and build orders vite build before the prerender because the first
empties dist/. Drops the sharp allowBuild, which was Next's image optimizer."
```

---

## Task 18: Reconcile the documentation

§15.7 requires this file to be updated when a contract changes. Four sections of AGENTS.md described a target that now exists, and one described a README behaviour this design deliberately reduced.

**Files:**
- Modify: `CLAUDE.md` (§0, §7, §9, §11), `ROADMAP.md`

- [ ] **Step 1: Rewrite §0**

Replace the whole of "§0. Where the code is vs. where this document points" with:

```markdown
## 0. Where the code is vs. where this document points

The write side (`packages/*`, `apps/workers`) and the read side (`apps/web`, `apps/api`) both
match this document. One deployable named in §7 does not exist yet: **`apps/backoffice`**.

While it is missing:

- `/admin` is served as a `noindex` 404 by `apps/api`. The routes the backoffice will call —
  `/api/admin/*` and `/api/commands/*` — already exist, because they are the contract, not
  the UI.
- §10 describes what that SPA must be when it lands. Nothing in it is built; nothing in it is
  cancelled.
- `/api/commands/*` authenticates and validates, then returns 501: the journal append is the
  open piece.

Two smaller gaps, both tracked in ROADMAP.md rather than here: `/api/mcp` and `/api/chat` are
declared and unimplemented, and the portal's search page is the ported baseline — no facet
sidebar, no keyboard navigation, no styling system.
```

- [ ] **Step 2: Amend §7's layout tree and add the prerender note**

In the repository layout block, replace the `apps/` subtree with:

```
├── apps/
│   ├── web/                       # public portal — Vite + React, static SPA
│   │   ├── src/                   # the browser bundle
│   │   └── prerender/             # Node build tooling: read model → static HTML
│   ├── api/                       # Fastify — the only backend process
│   │   └── src/routes/            # v1 · mcp · chat · readme · admin · commands
│   └── workers/
│       └── src/{discovery,crawler,analyzer,projector,replay,lib}/
```

and add one bullet to the import-boundaries list, after the `apps/web` / `apps/backoffice` one:

```markdown
- **`apps/web/prerender` is not bundle code.** It is a Node build step that reads the read
  model and writes files, so it may import `@keco/query`. It may not touch the write side, and
  lint scopes the browser rule to `apps/web/src` for exactly this reason.
```

- [ ] **Step 3: Amend §9's "SEO without SSR"**

Replace the first bullet of that subsection with:

```markdown
- A build step queries `tools` for the top N (~1000) by `score_total` and emits a real static
  HTML file per tool page — `<h1>`, `<title>`, meta description, JSON-LD `SoftwareApplication`,
  and the tool's `readme_excerpt` as indexable prose. It renders the *same* React route tree
  the browser mounts (`renderToString` under a static router), so what a crawler sees and what
  a reader sees cannot drift. Fastify serves that file when the build manifest lists the path
  and falls back to `index.html` otherwise; the SPA hydrates over it either way.
- **The full README is not inlined.** The markdown pipeline lives in `apps/api`, so the
  prerender stays a pure read-model consumer with no cache access and no second copy of the
  renderer. `readme_excerpt` (~1.5 KB, already in the document) is what a crawler indexes; the
  full sanitised README arrives client-side from `/api/readme/{owner}/{repo}`. This is a
  deliberate reduction of the SEO surface — if organic traffic shows it was the wrong trade,
  the fix is a shared renderer package, recorded as an ADR.
```

- [ ] **Step 4: Amend §11's "one implementation" paragraph**

Replace the paragraph beginning "Three machine front doors, **one implementation**" with:

```markdown
Three machine front doors, **one implementation**: `packages/query` holds all retrieval and
exports `searchTools() · getTool() · compareTools() · findAlternatives() · whatsHot()`. REST,
MCP and chat are thin adapters over it. A capability in one and not the others is a bug.

The portal is the deliberate exception. §9 has it querying Meilisearch from the browser with
the search-only key, and §7 bars a browser bundle from importing `@keco/query`. What the two
sides share is the *algebra* — `buildFilters`, `selectionFromParams`, `defaultFacets`,
`familyAttribute`, the sort specs — which lives in `@keco/core` precisely so both can reach it.
The portal's own client is `apps/web/src/lib/search.ts`, about sixty lines of `.search()` calls
over that shared algebra. Duplicating a filter mapping would drift; duplicating a `.search()`
call cannot.
```

- [ ] **Step 5: Update ROADMAP.md**

In "v1 → Read side", replace the **Search**, **Tool page** and **Auth** bullets:

```markdown
- 🚧 **Search** — ported to the Vite SPA with URL-synced state and browser-direct Meilisearch
  queries. Still to do: facet sidebar, list/grid toggle, keyboard navigation, richer empty
  states.
- 🚧 **Tool page** — ported, prerendered for the top 1000 by score, README rendered from the
  cache by `apps/api` (sanitised, relative URLs rewritten, badge paragraph stripped, Shiki).
  Still to do: install tabs, adopters with an `evidence_url`, score breakdown UI.
- ✅ **Auth** — single admin credential (`ADMIN_PASSWORD_HASH`, scrypt, signed HttpOnly
  session), re-checked inside every handler. Replaces the Auth.js + GitHub OAuth plan.
```

In "v0 — scaffold", replace the last bullet:

```markdown
- ✅ Portal, admin and API route skeletons; `mise run ci` green
- ✅ Read side on Vite + Fastify: static SPA, build-time prerender, one Node process
```

- [ ] **Step 6: Verify**

Run: `grep -rn "Next.js\|next dev\|next build\|NEXT_PUBLIC\|App Router" CLAUDE.md ROADMAP.md README.md`
Expected: only historical references that are explicitly framed as history (for example an ADR
recording the decision). Any sentence still describing the current system as Next.js is stale —
fix it.

Run: `mise run taxonomy:check && mise run ci`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md ROADMAP.md
git commit -m "docs: reconcile AGENTS.md with the Vite + Fastify read side

§0 now names apps/backoffice as the one missing deployable instead of describing
the whole read side as unbuilt. §7 gains the prerender directory and its boundary.
§9 records that the prerender inlines readme_excerpt rather than the full README,
and why. §11 states plainly that the portal shares the filter algebra, not the
query client."
```

---

## Task 19: Definition of done

The spec's acceptance criteria, run as commands. Nothing here is optional, and several of these check the *built artifact* rather than the source — a secret that leaks does so in `dist/`, not in a `.ts` file.

**Files:** none — this is verification.

- [ ] **Step 1: The §15 gate**

Run: `mise run ci`
Expected: check, lint, test and taxonomy:check all green.

- [ ] **Step 2: A full build produces a real SEO surface**

With Meilisearch running and at least one document in `tools` (run `mise run pipeline` first if
the index is empty):

```bash
mise run build
ls apps/web/dist/sitemap.xml apps/web/dist/robots.txt apps/web/dist/prerender-manifest.json
FILE=$(find apps/web/dist/prerendered -name '*.html' | head -1)
echo "$FILE"
grep -c "<h1" "$FILE"
grep -o "<title>[^<]*</title>" "$FILE"
grep -c "SoftwareApplication" "$FILE"
grep -c 'name="description"' "$FILE"
```
Expected: every file exists; the prerendered page reports ≥ 1 for each grep and a `<title>`
naming the tool. If `find` returns nothing because the index is empty, that is the empty-corpus
path — note it and re-run after a crawl before declaring this step done.

- [ ] **Step 3: No secret and no Node built-in reached the bundle**

```bash
grep -rn "MEILI_MASTER_KEY\|ADMIN_PASSWORD_HASH\|COMMAND_TOKEN\|SESSION_SECRET" apps/web/dist/assets/ || echo "clean: no server secret in the bundle"
grep -rn "node:fs\|node:path\|readFileSync" apps/web/dist/assets/ || echo "clean: no node built-in in the bundle"
grep -rlc "cncf-graduated" apps/web/dist/assets/ | head -1
```
Expected: both "clean" lines, and at least one asset containing the taxonomy — proving Task 1's
`browser` swap works in a production build.

- [ ] **Step 4: The boundaries hold in the source**

```bash
grep -rn "@keco/cache\|@keco/github\|@keco/signals\|@keco/analyze\|@keco/query\|@keco/search\|node:" apps/web/src/ || echo "clean: apps/web/src imports nothing it may not"
pnpm eslint .
```
Expected: the "clean" line and no lint errors.

- [ ] **Step 5: Next.js is gone**

```bash
grep -rn "\"next\"\|eslint-config-next\|server-only" --include=package.json apps packages || echo "clean: no Next dependency"
ls apps/web/.next 2>/dev/null || echo "clean: no .next output"
```
Expected: both "clean" lines.

- [ ] **Step 6: The deployed shape works**

```bash
mise run api &
sleep 2
curl -s localhost:3000/api/health
curl -s -o /dev/null -w 'deep link: %{http_code}\n' localhost:3000/tools/anything/at-all
curl -s -o /dev/null -w 'unknown api: %{http_code}\n' localhost:3000/api/nope
curl -s -o /dev/null -w 'admin: %{http_code}\n' localhost:3000/admin
curl -s -o /dev/null -w 'commands unauthed: %{http_code}\n' -X POST localhost:3000/api/commands/recrawl
kill %1
```
Expected: `{"status":"ok"}`, `deep link: 200`, `unknown api: 404`, `admin: 404`,
`commands unauthed: 401`.

- [ ] **Step 7: Read-side/write-side separation is intact**

Confirm by inspection, then state the finding explicitly in the completion report:

- Nothing in `apps/web` or `apps/api` writes to Meilisearch. `grep -rn "addDocuments\|updateDocuments\|deleteDocument\|updateSettings" apps/web apps/api` returns nothing.
- Nothing in `apps/workers` reads a read model except the projector, which writes it.
- `apps/api`'s only cache use is `getText` and `getJSON` on `repoKeys`. No `list`, no `put`.

- [ ] **Step 8: Final commit if anything was fixed**

```bash
git status --short
```
If steps 1–7 required fixes, commit them. Otherwise there is nothing to commit and the branch
is ready for review.

---

## Notes for the implementer

- **Task order matters twice.** Tasks 1–2 must land before anything in `apps/web`, because the
  bundle cannot import `@keco/core` until the taxonomy is isomorphic. Task 15 must land after
  Tasks 10–14, because the prerender renders the routes.
- **`mise run infra:up` is a prerequisite** for Tasks 15, 17 and 19 — the prerender queries
  Meilisearch, and an unreachable one is designed to fail the build.
- **`?raw` only works under Vite.** If `pnpm -F @keco/web check` complains about the import in
  `taxonomy-source.browser.ts`, `globals.d.ts` is not in the tsconfig's `include` — it is
  covered by `src/**/*.ts` in `packages/core`, not `apps/web`.
- **Shiki's first render is slow** (grammar and theme loading). If a test times out on the code
  fence case, that is what it is; the processor is built once at module scope so it is paid
  once per process.
- **`readme_excerpt` is the SEO payload.** If a change makes the tool page render nothing until
  a fetch resolves, the prerendered HTML becomes an empty shell and §9's requirement is broken.
  Task 19 step 2 is what catches it.
