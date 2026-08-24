import { expect, settled, test } from './app';

/**
 * The catch-all route. Worth an end-to-end test rather than a unit one because the thing that
 * actually breaks is not the component — it is the *server fallback* (§14): a deep link only
 * resolves because the host serves `index.html` for an unknown path. In development that is
 * Vite; in production it is `apps/api`. A route added to the client without checking the
 * fallback 404s on a hard refresh, and this suite is where that shows up.
 */
test.describe('not found', () => {
  test('an unknown path renders the 404 page, not a blank shell', async ({ page, visit }) => {
    await visit('/no/such/page');

    await expect(page.getByRole('heading', { name: 'Not found', level: 1 })).toBeVisible();
    await expect(page.getByText('That page does not exist.')).toBeVisible();
  });

  test('offers both ways back, and both work', async ({ page, visit }) => {
    await visit('/no/such/page');
    await page.getByRole('link', { name: 'search the ecosystem' }).click();
    await expect(page).toHaveURL('/search');
    await settled(page);

    await visit('/no/such/page');
    await page.getByRole('link', { name: 'the home page' }).click();
    await expect(page).toHaveURL('/');
  });

  test('the shell is still there, so the reader is not stranded', async ({ page, visit }) => {
    await visit('/no/such/page');

    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toBeVisible();
  });
});
