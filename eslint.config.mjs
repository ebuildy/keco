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

export default ts.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
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

  // The web app never fetches from third parties. It reads Meilisearch, and the
  // cache by key (tool page README) — nothing else.
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: boundary('apps/web must not import write-side packages (§7).', [
      ['@keco/github', '@keco/signals', '@keco/analyze'],
    ]),
  },

  // Only the projector writes to Meilisearch.
  {
    files: ['apps/workers/src/crawler/**/*.ts', 'apps/workers/src/analyzer/**/*.ts'],
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
