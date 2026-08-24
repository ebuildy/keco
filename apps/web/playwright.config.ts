import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the portal — **no backend of any kind**.
 *
 * `mise run e2e` starts Vite with `VITE_MOCK=1`, which is the same in-browser mock backend
 * `mise run web:mock` uses (`src/mocks/**`): MSW intercepts every Meilisearch call and
 * `/api/readme/...` inside the page and answers them from ~300 fixture documents. So no
 * Meilisearch, no Docker, no `apps/api`, no GitHub token — the only process is the dev server
 * Playwright starts here, serving the bundle.
 *
 * That is also the reason these tests cannot run against a production build: `main.tsx` gates
 * the mock behind `import.meta.env.DEV`, which Rollup eliminates, and `assert:no-mocks` fails
 * the build if a fixture ever reaches `dist/` (§14). Coverage of the *built* artefact belongs
 * to `mise run build` and the prerender suites, not here.
 *
 * Chromium only, deliberately: nothing under test is engine-specific, and a suite that needs
 * three browser downloads is one people switch off.
 */
const PORT = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: './e2e',
  // Not `*.spec.ts` / `*.test.ts`: the root vitest config globs `apps/*/src/**/*.test.ts` and
  // friends, and a shared suffix is how a Playwright file ends up being run by vitest.
  testMatch: '**/*.e2e.ts',

  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    // CopyButton writes an install command to the clipboard, and reading it back is the only
    // honest way to assert it copied the *verified* string rather than something constructed.
    permissions: ['clipboard-read', 'clipboard-write'],
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // `e2e:serve` runs `msw init` first: the worker script is gitignored and `mise run build`
    // deletes it, so a clean checkout — or any machine that has built recently — has none.
    command: `pnpm run e2e:serve --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
