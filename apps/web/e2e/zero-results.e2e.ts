import { expect, results, settled, test } from './app';

/**
 * The zero-result state (§9: "empty and zero-result states must suggest something useful").
 *
 * "Useful" here is a specific claim, and these tests are mostly about holding it: every offer
 * on the page is a one-click action derived from what the reader actually did, and every "did
 * you mean" has been *verified to return hits* before it is rendered. A suggestion that leads
 * to a second dead end would be the same class of unproven claim §6 bans for install commands,
 * so the assertion below follows each suggestion through rather than just seeing it.
 */
test.describe('zero results', () => {
  test('a query that matches nothing says so, and offers a way out', async ({ page, visit }) => {
    await visit('/search?q=zzzznothinghere');
    await settled(page);

    await expect(page.getByRole('heading', { name: 'No tools match “zzzznothinghere”' })).toBeVisible();
    await expect(page.getByText('Nothing in the corpus matches that search.')).toBeVisible();
    await expect(results(page)).toHaveCount(0);

    // No filters are applied, so the only honest recovery is to drop the query.
    await expect(page.getByRole('button', { name: /Clear/ })).toHaveCount(0);
    await page.getByRole('link', { name: 'Browse everything instead' }).click();

    await expect(page).toHaveURL('/search');
    await settled(page);
    await expect(results(page)).toHaveCount(20);
  });

  test('the sidebar gets out of the way when there is nothing to filter', async ({
    page,
    visit,
  }) => {
    await visit('/search?q=zzzznothinghere');
    await settled(page);

    // Keeping the two-column grid would render the empty state in a 210px sliver at the exact
    // moment it is the only thing on the page.
    await expect(page.getByRole('heading', { name: 'Filters' })).toHaveCount(0);
  });

  test('filters alone that match nothing offer to clear themselves', async ({ page, visit }) => {
    // A learning resource that runs in-cluster: both values exist, nothing is both.
    await visit('/search?kind=learning-resource&runtime=in-cluster');
    await settled(page);

    await expect(page.getByRole('heading', { name: 'No tools match these filters' })).toBeVisible();
    await expect(page.getByText('Those filters have no tools in common.')).toBeVisible();

    await page.getByRole('button', { name: 'Clear all filters' }).click();
    await expect(page).toHaveURL('/search');
    await settled(page);
    await expect(results(page)).not.toHaveCount(0);
  });

  test('a query plus filters offers both halves separately', async ({ page, visit }) => {
    await visit('/search?q=helm&kind=learning-resource');
    await settled(page);

    await expect(page.getByRole('heading', { name: 'No tools match “helm”' })).toBeVisible();
    await expect(page.getByText('Nothing matches that search with the filter you have applied.'))
      .toBeVisible();

    // Keep the query, drop the filter — the filter is the usual culprit, so it leads.
    await expect(page.getByRole('button', { name: 'Search all tools for “helm”' })).toBeVisible();

    await page.getByRole('button', { name: 'Keep the filters, clear the search' }).click();
    await expect(page).toHaveURL('/search?kind=learning-resource');
    await settled(page);
    await expect(results(page)).not.toHaveCount(0);
  });

  test('“did you mean” only offers corrections that return hits, and they do', async ({
    page,
    visit,
  }) => {
    // A mangled taxonomy word: past Meilisearch's own typo tolerance, correctable offline
    // against the bundled vocabulary, and verified by a `multiSearch` before it is rendered.
    await visit('/search?q=observabilty');
    await settled(page);

    const suggestions = page.getByRole('heading', { name: 'Did you mean' });
    await expect(suggestions).toBeVisible();

    const correction = page.getByRole('button', { name: /^observability/ });
    await expect(correction).toBeVisible();
    // Each suggestion states the number of hits it will produce — that is the proof, on screen.
    await expect(correction).toContainText(/\d/);

    await correction.click();
    await expect(page).toHaveURL('/search?q=observability');
    await settled(page);
    await expect(results(page)).not.toHaveCount(0);
  });

  test('popular categories come from the corpus and lead somewhere real', async ({
    page,
    visit,
  }) => {
    await visit('/search?q=zzzznothinghere');
    await settled(page);

    const categories = page.getByRole('navigation', { name: 'Popular categories' });
    await expect(categories).toBeVisible();

    const first = categories.getByRole('link').first();
    const href = await first.getAttribute('href');
    await first.click();

    await expect(page).toHaveURL(href!);
    await settled(page);
    await expect(results(page)).not.toHaveCount(0);
  });

  test('explains what the corpus is rather than only apologising', async ({ page, visit }) => {
    await visit('/search?q=zzzznothinghere');
    await settled(page);

    await expect(
      page.getByText('Every tool here is classified from public GitHub data and ranked by health'),
    ).toBeVisible();
  });
});
