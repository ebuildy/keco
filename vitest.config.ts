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
    // Shiki's first render loads grammars and themes lazily. Warming it here keeps that cost
    // off the clock of whichever test would otherwise render first — see the setup file.
    setupFiles: ['apps/api/src/readme/warm.test-setup.ts'],
  },
});
