import js from '@eslint/js';
import ts from 'typescript-eslint';

/**
 * Import boundaries (AGENTS.md §7) are enforced here, not by convention.
 * Each rule below encodes one line of the CQRS contract; if you need to relax one,
 * the design is probably wrong — re-read §2 first.
 */
const boundary = (message, patterns) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ group, message })) }],
});

/** The portal bundle's permanent import ban (§7). Named so the mock rule can re-apply it. */
const BROWSER_GROUPS = [
  ['@keco/cache', '@keco/cache/*', '@keco/github', '@keco/signals', '@keco/analyze'],
  ['@keco/query', '@keco/search'],
  ['node:*', 'fs', 'path', 'crypto', 'os'],
];

/** Development-and-test-only mock backend — see the governing invariant in its design spec. */
const MOCK_GROUP = ['**/mocks', '**/mocks/*', '**/mocks/**'];

export default ts.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'packages/analyze/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // `any` is banned outside verbatim cached GitHub payloads (§13).
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // The read side never writes, and never touches write-side clients.
  {
    files: ['packages/query/**/*.ts'],
    rules: boundary('packages/query is read-side: it may import @keco/search only (§7).', [
      ['@keco/cache', '@keco/github', '@keco/signals', '@keco/analyze'],
    ]),
  },

  // The portal bundle ships to strangers. Anything it imports is public, so the rule is not
  // "no write-side packages" but "@keco/core and meilisearch, and nothing else" (§7).
  // @keco/query and @keco/search are read-side and harmless in themselves, but @keco/search
  // carries createAdminClient, which reads MEILI_MASTER_KEY — a bundle must not be one
  // tree-shaking mistake away from that.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: boundary(
      'apps/web/src is a browser bundle: @keco/core and meilisearch only, and no node:* (§7).',
      [...BROWSER_GROUPS, MOCK_GROUP],
    ),
  },

  // The mock backend is development and test only. Application code must never import it, or
  // fabricated repos, scores and install commands reach real readers (§6). main.tsx holds the
  // dev-only branch that loads it; test files use the corpus as fixtures. Nothing else may.
  // This block re-applies BROWSER_GROUPS rather than adding to the one above: flat config is
  // last-match-wins per rule key, so omitting them here would unguard these files entirely.
  {
    files: [
      'apps/web/src/main.tsx',
      'apps/web/src/**/*.test.ts',
      'apps/web/src/mocks/**/*.ts',
    ],
    rules: boundary(
      'apps/web/src is a browser bundle: @keco/core and meilisearch only, and no node:* (§7).',
      BROWSER_GROUPS,
    ),
  },

  // Not bundle code: this is Node build tooling that reads the read model and writes files.
  // It may hold a query client; it still may not touch the write side. MOCK_GROUP is included
  // for the same reason as the block above: the prerender writes HTML straight into `dist/`,
  // and "seed the prerender from fixtures when the index is empty" is exactly the change the
  // design spec's "Preserving the invariant" section forbids — without this, the corpus import
  // would pass lint here even though nothing else in the bundle rules allows it.
  {
    files: ['apps/web/prerender/**/*.ts'],
    rules: boundary(
      'apps/web/prerender is build tooling: it may read the read model, never the write side, and never the mock backend (§7).',
      [['@keco/cache', '@keco/cache/*', '@keco/github', '@keco/signals', '@keco/analyze'], MOCK_GROUP],
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

  // Only the projector writes to Meilisearch.
  {
    files: [
      'apps/workers/src/discovery/**/*.ts',
      'apps/workers/src/crawler/**/*.ts',
      'apps/workers/src/analyzer/**/*.ts',
    ],
    rules: boundary(
      'Only the projector may import @keco/search. The write side never reads a read model (§2.1).',
      [['@keco/search']],
    ),
  },

  // Signal providers are only reachable through the analyzer, and only via the cache.
  {
    files: ['packages/signals/**/*.ts'],
    rules: boundary(
      'A signal provider must go through @keco/cache — never call a third party uncached (§4.2).',
      [['@keco/search', '@keco/query']],
    ),
  },
);
