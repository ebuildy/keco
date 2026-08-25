import { expect, results, settled, test, toolHeading } from './app';
import { CORPUS_TOTAL, ICONLESS, WITH_ICON } from './corpus';

/**
 * `/search` — every piece of state is in the URL (`?q=&kind=&domain=&install=&sort=&view=`),
 * which is what makes a result set shareable and the back button work (§9). Most assertions
 * here are therefore about the URL as much as about the DOM: the two are the same state.
 */
test.describe('search page', () => {
  test('an empty search lists the whole public corpus', async ({ page, visit }) => {
    await visit('/search');
    await settled(page);

    await expect(
      page.getByText(`${CORPUS_TOTAL.toLocaleString('en-GB')} tools ·`),
    ).toBeVisible();
    await expect(results(page)).toHaveCount(20);
  });

  test('a query in the URL is the query on screen', async ({ page, visit }) => {
    await visit('/search?q=gitops');
    await settled(page);

    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toHaveValue('gitops');
    await expect(results(page).first()).toContainText('argo-cd');
  });

  test('the header field runs a new search', async ({ page, visit }) => {
    await visit('/search');
    await settled(page);

    await page.getByLabel('Search the Kubernetes ecosystem').fill('trivy');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/search?q=trivy');
    await expect(results(page).first()).toContainText('trivy');
  });

  test('a facet filters, shows an active chip, and the chip removes it', async ({
    page,
    visit,
  }) => {
    await visit('/search');
    await settled(page);
    const unfiltered = await results(page).count();

    // `.click()`, not `.check()`: toggling re-runs the search, which rebuilds the sidebar from
    // the new distribution — Playwright's `check()` re-reads the element it clicked and fails
    // when React has replaced it. The URL is the assertion that matters anyway.
    await page.getByRole('group', { name: 'Kind' }).getByRole('checkbox', { name: /^CLI/ }).click();
    await expect(page).toHaveURL('/search?kind=cli');
    await settled(page);

    // Every card on screen is now a CLI, and the selection is stated back to the reader.
    for (const chip of await page.locator('main a[href^="/tools/"] >> text=kind: cli').all()) {
      await expect(chip).toBeVisible();
    }
    // The family and its value are separate text nodes, so the accessible name has them
    // space-joined — "Kind : CLI". The lowercasing is CSS only and does not reach the name.
    const active = page.getByRole('button', { name: /^Kind\s*: CLI/ });
    await expect(active).toBeVisible();

    await active.click();
    await expect(page).toHaveURL('/search');
    await settled(page);
    expect(await results(page).count()).toBe(unfiltered);
  });

  test('two facets from different families combine', async ({ page, visit }) => {
    await visit('/search?kind=operator&domain=security');
    await settled(page);

    await expect(page.getByRole('checkbox', { name: /^Operator/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /^Security/ })).toBeChecked();
    await expect(results(page).first()).toContainText('kind: operator');

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(page).toHaveURL('/search');
  });

  test('sorting by stars reorders, and lives in the URL', async ({ page, visit }) => {
    await visit('/search');
    await settled(page);

    await page.getByLabel('Sort results').selectOption('stars');
    await expect(page).toHaveURL('/search?sort=stars');
    await settled(page);

    // traefik/traefik is the most-starred fixture in the public corpus.
    await expect(results(page).first()).toContainText('traefik');
  });

  test('the view toggle switches to grid and back', async ({ page, visit }) => {
    await visit('/search');
    await settled(page);

    await page.getByRole('button', { name: 'Grid view' }).click();
    await expect(page).toHaveURL('/search?view=grid');
    await expect(page.getByRole('button', { name: 'Grid view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'List view' }).click();
    // `list` is the default, so it is dropped from the URL rather than written out.
    await expect(page).toHaveURL('/search');
  });

  test('paging shows a different page of the same result set', async ({ page, visit }) => {
    await visit('/search');
    await settled(page);
    const firstOfPageOne = await results(page).first().getAttribute('href');

    await visit('/search?page=2');
    await settled(page);

    await expect(results(page)).toHaveCount(20);
    expect(await results(page).first().getAttribute('href')).not.toBe(firstOfPageOne);
  });

  test('the back button undoes a filter, because the filter is the URL', async ({
    page,
    visit,
  }) => {
    await visit('/search?q=operator');
    await settled(page);

    await page.getByRole('checkbox', { name: /^Operator/ }).click();
    await expect(page).toHaveURL('/search?q=operator&kind=operator');
    await settled(page);

    await page.goBack();
    await expect(page).toHaveURL('/search?q=operator');
    await expect(page.getByRole('checkbox', { name: /^Operator/ })).not.toBeChecked();
  });

  test('a result opens its tool page', async ({ page, visit }) => {
    await visit('/search?q=k9s');
    await settled(page);

    await results(page).first().click();
    await expect(page).toHaveURL('/tools/derailed/k9s');
    await expect(toolHeading(page)).toHaveText('k9s');
  });

  test('archived repositories are filtered out of search', async ({ page, visit }) => {
    await visit('/search?q=datree');
    await settled(page);

    // It is still reachable by direct link (see the tool-page suite) — `buildFilters` keeps it
    // out of the corpus a reader browses, it does not delete it.
    await expect(page.getByText('No tools match “datree”')).toBeVisible();
  });
});

/** §9's keyboard contract: `/` focuses, arrows move, enter opens. */
test.describe('search keyboard navigation', () => {
  test('/ focuses the field from anywhere on the page', async ({ page, visit }) => {
    await visit('/search');
    await settled(page);

    await page.getByRole('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toBeFocused();
  });

  test('arrow keys move focus down the list and back to the field', async ({ page, visit }) => {
    await visit('/search?q=gitops');
    await settled(page);

    await page.getByLabel('Search the Kubernetes ecosystem').focus();
    await page.keyboard.press('ArrowDown');
    await expect(results(page).first()).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(results(page).nth(1)).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(results(page).first()).toBeFocused();

    // ↑ from the first result returns to the field rather than wrapping to the last result.
    await page.keyboard.press('ArrowUp');
    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toBeFocused();
  });

  test('enter opens the focused result', async ({ page, visit }) => {
    await visit('/search?q=k9s');
    await settled(page);

    await page.getByLabel('Search the Kubernetes ecosystem').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/tools/derailed/k9s');
  });

  test('escape from a result returns focus to the field; escape again clears the query', async ({
    page,
    visit,
  }) => {
    await visit('/search?q=gitops');
    await settled(page);

    await page.getByLabel('Search the Kubernetes ecosystem').focus();
    await page.keyboard.press('ArrowDown');
    await expect(results(page).first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toBeFocused();

    // The native `type="search"` clear only empties the visible value; `?q=` and the results
    // would stand. Clearing the URL is what actually resets the page.
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL('/search');
    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toHaveValue('');
    await expect(page.getByLabel('Search the Kubernetes ecosystem')).toBeFocused();
  });
});

test.describe('result icons', () => {
  test('shows the project icon at the result size', async ({ page, visit }) => {
    await visit(`/search?q=${encodeURIComponent(WITH_ICON.name)}`);
    await settled(page);

    const card = page.locator(`main ul > li:has(a[href="/tools/${WITH_ICON.full_name}"])`);
    const icon = card.locator('[data-icon="image"]');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('src', `/api/icon/${WITH_ICON.full_name}/32.png`);
    // The 2x source is the 64px derivative, not an upscale of the 32.
    await expect(icon).toHaveAttribute(
      'srcset',
      new RegExp(`/api/icon/${WITH_ICON.full_name}/64\\.png 2x`),
    );
  });

  // A result list where some cards have an image and others have nothing would read as broken.
  test('stands a monogram in for a repo with no icon', async ({ page, visit }) => {
    await visit(`/search?q=${encodeURIComponent(ICONLESS.name)}`);
    await settled(page);

    const card = page.locator(`main ul > li:has(a[href="/tools/${ICONLESS.full_name}"])`);
    await expect(card.locator('[data-icon="monogram"]')).toBeVisible();
    await expect(card.locator('[data-icon="image"]')).toHaveCount(0);
  });

  // Decorative: the repository's name is right beside it, and announcing it twice is noise.
  test('keeps the icon out of the accessibility tree', async ({ page, visit }) => {
    await visit(`/search?q=${encodeURIComponent(WITH_ICON.name)}`);
    await settled(page);

    const card = page.locator(`main ul > li:has(a[href="/tools/${WITH_ICON.full_name}"])`);
    await expect(card.locator('[data-icon="image"]')).toHaveAttribute('aria-hidden', 'true');

    // The card's only exposed `img` role is the health meter, which earns it: it carries a
    // label a screen reader can read. The project icon adds nothing the adjacent name does not
    // already say, so it must not appear here at all.
    await expect(card.getByRole('img')).toHaveCount(1);
    await expect(card.getByRole('img')).toHaveAccessibleName(new RegExp(`${WITH_ICON.full_name} health`));
  });
});
