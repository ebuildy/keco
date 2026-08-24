import { expect, settled, test } from './app';
import { K9S } from './corpus';

/**
 * The app shell — header, footer, theme, and the shortcuts `AppShell` promises on every route.
 *
 * The theme assertions are the load-bearing ones. `index.html`'s inline bootstrap stamps
 * `data-theme` before first paint, and it does so *only* for an explicit stored choice: with no
 * choice the attribute stays absent and `prefers-color-scheme` decides. That asymmetry is what
 * `@custom-variant dark`'s two branches exist for, and it is invisible to `tsc` — the failure
 * mode is a page that half-applies dark mode, which only a browser can see.
 */
test.describe('app shell', () => {
  test('the header links home from a deep page, and the footer states what Keco is', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${K9S.full_name}`);

    await expect(page.getByRole('contentinfo')).toContainText(
      'there is no curation and no editorial content',
    );

    await page.getByRole('banner').getByRole('link', { name: 'Keco' }).click();
    await expect(page).toHaveURL('/');
  });

  test('the compact search field appears everywhere except the home page', async ({
    page,
    visit,
  }) => {
    await visit('/');
    // On `/` the hero field is the page's subject; a second one would be two controls
    // competing for the same job. Exactly one element ever carries the shared id.
    await expect(page.getByRole('banner').getByRole('searchbox')).toHaveCount(0);
    await expect(page.locator('#site-search')).toHaveCount(1);

    await visit(`/tools/${K9S.full_name}`);
    await expect(page.getByRole('banner').getByRole('searchbox')).toHaveCount(1);
    await expect(page.locator('#site-search')).toHaveCount(1);
  });

  test('/ focuses the search field from a tool page and from the 404', async ({ page, visit }) => {
    for (const path of [`/tools/${K9S.full_name}`, '/nothing-here']) {
      await visit(path);
      await page.keyboard.press('/');
      await expect(page.getByLabel('Search the Kubernetes ecosystem')).toBeFocused();
    }
  });

  test('searching from the header reaches the search page from any route', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${K9S.full_name}`);

    await page.getByLabel('Search the Kubernetes ecosystem').fill('backup');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/search?q=backup');
    await settled(page);
  });

  test('the skip link is the first tab stop and lands focus on the content', async ({
    page,
    visit,
  }) => {
    await visit('/');

    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();

    await page.keyboard.press('Enter');
    // `tabIndex={-1}` on the target is what makes this land focus rather than only scroll.
    await expect(page.locator('#content')).toBeFocused();
  });
});

test.describe('theme', () => {
  test('follows the OS preference with no stored choice, and stamps no attribute', async ({
    page,
    visit,
  }) => {
    await visit('/');

    // The attribute means exactly one thing: "a human overrode the OS". Absent is the default.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
    await expect(page.getByRole('button', { name: 'Switch to the dark theme' })).toBeVisible();
  });

  test('a system-dark reader gets the dark palette without the attribute', async ({
    page,
    visit,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await visit('/');

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
    // The toggle reads what is actually on screen, so it must offer *light* here.
    await expect(page.getByRole('button', { name: 'Switch to the light theme' })).toBeVisible();
  });

  test('the toggle stamps the attribute, persists it, and survives a reload', async ({
    page,
    visit,
  }) => {
    await visit('/');

    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Switch to the light theme' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await page.evaluate(() => localStorage.getItem('keco-theme'))).toBe('dark');

    // The inline bootstrap runs before first paint, so the attribute is there on the next load
    // rather than flashing light and correcting on hydration.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Switch to the light theme' })).toBeVisible();
  });

  test('an explicit light choice overrides a system-dark preference', async ({ page, visit }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await visit('/');

    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('button', { name: 'Switch to the dark theme' })).toBeVisible();
  });

  test('the choice carries across a client navigation', async ({ page, visit }) => {
    await visit('/');
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();

    await page.getByRole('navigation', { name: 'Kind' }).getByRole('link').first().click();
    await settled(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
