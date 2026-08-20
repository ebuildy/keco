import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/prerender/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: true,
    // Shiki's first render loads grammars and themes lazily, measured at up to 6.6s under
    // full-suite CPU contention — past vitest's 5s per-test default. This used to be a global
    // setupFile, which cost every package in the monorepo a Shiki warm-up whether or not it
    // ever touched Shiki (packages/core: 17.78s of setup for 45ms of actual tests). Only
    // apps/api/src/readme/render.test.ts and apps/api/src/routes/readme.test.ts call through
    // to Shiki, and each now pays the warm-up itself via a module-level `await
    // warmReadmeRenderer()` before its tests run — see those files.
  },
});
