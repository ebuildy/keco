import { formatUtcDate } from '../src/lib/dates';
import { expect, test, toolHeading } from './app';
import { CORPUS_TOTAL, TOP_MOMENTUM } from './corpus';

/** `/` — hero search, Browse (one chip row per facetable family), Highest momentum (§9). */
test.describe('home page', () => {
  test('states the corpus size and when it was indexed', async ({ page, visit }) => {
    await visit('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Find the right Kubernetes tool in 10 seconds',
    );
    // Freshness, not liveness: `indexed_at` is when the projector wrote the document (§2.7).
    await expect(page.getByText(`${CORPUS_TOTAL.toLocaleString('en-GB')} repositories classified`))
      .toBeVisible();
    await expect(
      page.getByText(`updated ${formatUtcDate(TOP_MOMENTUM[0]!.indexed_at)}`),
    ).toBeVisible();
  });

  test('the hero field searches', async ({ page, visit }) => {
    await visit('/');

    await page.getByLabel('Search the Kubernetes ecosystem').fill('gitops');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page).toHaveURL('/search?q=gitops');
    await expect(page.getByRole('main').getByText(/tools ·/)).toBeVisible();
  });

  test('Browse renders one row per facetable family, and every chip filters', async ({
    page,
    visit,
  }) => {
    await visit('/');

    const kindRow = page.getByRole('navigation', { name: 'Kind' });
    await expect(kindRow.getByRole('link')).not.toHaveCount(0);

    // A value with zero documents renders no chip, so every chip on the page is a live link.
    const operators = kindRow.getByRole('link', { name: /^Operator/ });
    await operators.click();

    await expect(page).toHaveURL('/search?kind=operator');
    await expect(page.getByRole('checkbox', { name: /^Operator/ })).toBeChecked();
  });

  test('Highest momentum lists the top of the corpus, in order, labelled honestly', async ({
    page,
    visit,
  }) => {
    await visit('/');

    const section = page.getByRole('heading', { name: 'Highest momentum' });
    await expect(section).toBeVisible();
    // §4.4: there is no time series behind this number, so it must never claim one.
    await expect(page.getByText('stars per day of age, damped by activity')).toBeVisible();
    await expect(page.getByText(/trending/i)).toHaveCount(0);

    const cards = page.locator('main ul > li > a[href^="/tools/"]');
    await expect(cards).toHaveCount(TOP_MOMENTUM.length);
    await expect(cards.first()).toHaveAttribute('href', `/tools/${TOP_MOMENTUM[0]!.full_name}`);
    await expect(cards.first()).toContainText(TOP_MOMENTUM[0]!.score.total.toFixed(2));
  });

  test('a momentum card opens its tool page', async ({ page, visit }) => {
    await visit('/');

    const first = TOP_MOMENTUM[0]!;
    await page.locator(`main a[href="/tools/${first.full_name}"]`).click();

    await expect(page).toHaveURL(`/tools/${first.full_name}`);
    await expect(toolHeading(page)).toHaveText(first.name);
  });

  test('promises the keyboard shortcut it implements', async ({ page, visit }) => {
    await visit('/');

    await expect(page.getByText('Press / anywhere to search.')).toBeVisible();
    await page.keyboard.press('/');
    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toBeFocused();
  });
});
