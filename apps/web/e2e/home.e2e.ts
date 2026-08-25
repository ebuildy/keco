import { formatUtcDate } from '../src/lib/dates';
import { expect, test, toolHeading } from './app';
import { CORPUS_TOTAL, ICONLESS, TOP_MOMENTUM, WITH_ICON } from './corpus';

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

/**
 * The momentum grid is the third surface that renders a tool, after the result card and the
 * tool page — and it is hand-written markup rather than a shared card, which is exactly how it
 * was missed the first time. Every surface a reader can reach carries its own test (§13).
 */
test.describe('momentum card icons', () => {
  test('shows an icon or a monogram on every momentum card', async ({ page, visit }) => {
    await visit('/');

    // The momentum list arrives from a query, so wait for the section rather than counting
    // whatever happens to be mounted — an earlier version of this test read the grid mid-render
    // and failed about one run in four.
    await expect(page.getByRole('heading', { name: 'Highest momentum' })).toBeVisible();

    const cards = page.locator('main ul > li:has(a[href^="/tools/"])');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    // Not "some card has an icon": the icons across all cards number exactly as many as the
    // cards, so the grid never has a ragged row where one title starts further left than its
    // neighbour's. One auto-retrying assertion rather than a loop of them, which is what makes
    // it immune to the race above.
    await expect(cards.locator('[data-icon]')).toHaveCount(count);
  });

  test('uses the result-card source size, not the tool page one', async ({ page, visit }) => {
    await visit('/');

    const withIcon = page.locator(`main ul > li:has(a[href="/tools/${WITH_ICON.full_name}"])`);
    // Only assert the source when this fixture actually made the momentum list.
    if ((await withIcon.count()) > 0) {
      await expect(withIcon.locator('[data-icon="image"]')).toHaveAttribute(
        'src',
        `/api/icon/${WITH_ICON.full_name}/32.png`,
      );
    }

    const iconless = page.locator(`main ul > li:has(a[href="/tools/${ICONLESS.full_name}"])`);
    if ((await iconless.count()) > 0) {
      await expect(iconless.locator('[data-icon="monogram"]')).toBeVisible();
    }
  });
});
