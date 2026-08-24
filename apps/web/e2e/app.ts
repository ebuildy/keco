import { expect, test as base, type Page } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * Shared fixtures for the portal's end-to-end suites.
 *
 * Everything here exists to keep the tests honest about *what they are testing against*. The
 * portal under test talks to an in-browser mock backend (`src/mocks/**`), and the failure mode
 * that matters is not a broken assertion — it is a mock that never started. `main.tsx`
 * deliberately degrades in that case: it logs, then renders anyway against whatever real
 * backend is configured. In a developer's terminal that is the right behaviour; in a test run
 * it would turn "the mock is dead" into "search returns nothing", which reads as a portal bug
 * and is not one.
 *
 * So the `page` fixture below fails the test on any console error or uncaught exception. MSW is
 * started with `onUnhandledRequest: 'error'`, which means a request the mock does not model —
 * a new endpoint added to `src/lib/search.ts` without a matching handler — surfaces here as a
 * failure rather than as an empty page nobody looks at twice.
 */
type Fixtures = {
  /** Navigates and waits for the app shell, so a test never asserts against a blank document. */
  visit: (path: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    const problems: string[] = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      // Chromium logs every non-2xx response as a console error, including the ones the portal
      // asks for and handles: `/api/readme/...` 404s for a repo the crawler has not reached,
      // and a document 404 behind an unknown `/tools/...` URL. Both are ordinary states with
      // their own assertions elsewhere in this suite. MSW's unhandled-request error is a
      // different message and still fails here, which is the case worth catching.
      if (message.text().startsWith('Failed to load resource')) return;
      problems.push(`console.error: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));

    await use(page);

    expect(problems, 'the page logged errors — see src/mocks and the note in e2e/app.ts').toEqual(
      [],
    );
  },

  visit: async ({ page }, use) => {
    await use(async (path: string) => {
      await page.goto(path);
      await expect(page.getByRole('banner')).toBeVisible();
    });
  },
});

/**
 * The tool page's own `<h1>`.
 *
 * `.first()` is not laziness: the README below it is corpus-derived HTML that routinely opens
 * with its own `<h1>` — `derailed/k9s` renders "K9s" under the page's "k9s". The page's
 * heading is the first in document order, and treating a repository's documentation as if it
 * competed with the page's title would be the test asserting something the reader never sees.
 */
export const toolHeading = (page: Page) => page.getByRole('heading', { level: 1 }).first();

/**
 * The result cards on `/search`, and the momentum cards on `/`.
 *
 * Matched by what a result *is* — a link into `/tools/…` inside the page's own list — rather
 * than by `listitem`, which also collects the zero-result state's suggestion and category
 * chips. The anchor rather than the `<li>` because the anchor is what the roving tabindex
 * focuses, so `toBeFocused()` means what it says.
 */
export const results = (page: Page) => page.locator('main ul > li > a[href^="/tools/"]');

/**
 * Waits for the search page to have settled on an answer. The page debounces ~80 ms and every
 * URL write re-issues, so asserting straight after a navigation races the request that is
 * about to replace what is on screen.
 */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByText(/\d[\d,]* tools ·/)).toBeVisible();
}
