import { formatUtcDate } from '../src/lib/dates';
import { expect, test, toolHeading } from './app';
import { ARCHIVED, BARE_TOOL, K9S, KUBECTX } from './corpus';

/**
 * `/tools/:owner/:repo` — the SEO surface, and the only route the prerender emits as static
 * HTML (§9). These tests exercise the *client* render of it: the dev server serves the SPA
 * shell, so what is asserted here is the same route tree `renderToString` walks, mounted
 * fresh. Whether the prerendered file itself carries an `<h1>` and JSON-LD is
 * `prerender/ssr.test.ts`'s job and `mise run build`'s, not this suite's.
 */
test.describe('tool page', () => {
  test('shows the document, and says when it was indexed rather than implying it is live', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${K9S.full_name}`);

    await expect(toolHeading(page)).toHaveText(K9S.name);
    await expect(page.getByText(K9S.full_name, { exact: true })).toBeVisible();
    await expect(page.getByText(K9S.summary)).toBeVisible();

    // §14: `indexed_at` is when the projector wrote the document. It never claims the tool
    // itself changed.
    await expect(page.getByText(`Data from GitHub, indexed ${K9S.indexed_at}`)).toBeVisible();
  });

  test('renders the taxonomy as labels and the health score as magnitude', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${K9S.full_name}`);

    await expect(page.getByText(`kind: ${K9S.kind}`)).toBeVisible();
    for (const domain of K9S.domains) await expect(page.getByText(domain, { exact: true })).toBeVisible();

    const health = page.getByRole('region', { name: 'Health' });
    await expect(health.getByText(K9S.score.total.toFixed(2), { exact: true })).toBeVisible();
    await expect(health.getByText('of 1.00')).toBeVisible();
    // A 0.9 from four signals and a 0.9 from one are not the same claim (§4.4).
    await expect(health).toContainText(
      `Quality scored on ${Math.round(K9S.score.quality_coverage * 100)}% of its signals`,
    );
    await expect(health).toContainText('treated as unknown, not as zero');
  });

  test('lists repository facts from the document', async ({ page, visit }) => {
    await visit(`/tools/${K9S.full_name}`);

    await expect(page.getByText(K9S.stars.toLocaleString('en-GB'))).toBeVisible();
    await expect(page.getByText(formatUtcDate(K9S.pushed_at))).toBeVisible();
    await expect(page.getByRole('link', { name: '↗ Source on GitHub' })).toHaveAttribute(
      'href',
      K9S.repo_url,
    );
  });

  test('an install command is copyable verbatim, and carries its proof', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${K9S.full_name}`);

    const method = K9S.install_methods[0]!;
    await expect(page.getByRole('tab', { name: method.method })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tabpanel')).toContainText(method.command);

    // Nothing constructs this string: it is copied out of the document, which is the whole
    // point — people paste these into a terminal (§6).
    await page.getByRole('button', { name: 'Copy' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(method.command);

    await expect(page.getByRole('link', { name: 'Proof this entry exists' })).toHaveAttribute(
      'href',
      method.source_url,
    );
  });

  test('several verified methods are tabs, switchable by click and by arrow key', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${KUBECTX.full_name}`);

    const [first, second] = KUBECTX.install_methods;
    await expect(page.getByRole('tablist', { name: 'Install methods' })).toContainText(
      `${KUBECTX.install_methods.length} verified against a registry`,
    );

    await page.getByRole('tab', { name: second!.method }).click();
    await expect(page.getByRole('tabpanel')).toContainText(second!.command);

    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tabpanel')).toContainText(first!.command);
  });

  test('an unproven install method is not rendered at all', async ({ page, visit }) => {
    await visit(`/tools/${BARE_TOOL.full_name}`);

    // Silence beats a guess: no tabs, no invented `brew install <fixture>` line.
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(
      page.getByText('No install method has been verified against a registry, so none is listed.'),
    ).toBeVisible();
  });

  test('the README arrives from apps/api and renders as prose', async ({ page, visit }) => {
    await visit(`/tools/${K9S.full_name}`);

    const readme = page.getByRole('region', { name: 'README' });
    // Sanitised server-side before it ever reached the browser — the mock returns the same
    // already-safe HTML shape apps/api does.
    await expect(readme.getByRole('heading', { name: 'K9s', level: 1 })).toBeVisible();
    await expect(readme.getByRole('heading', { name: 'Installation' })).toBeVisible();
  });

  test('no cached README falls back to the indexable excerpt', async ({ page, visit }) => {
    await visit(`/tools/${BARE_TOOL.full_name}`);

    // An ordinary state before the crawler reaches a repo, not an error — and the excerpt is
    // what a crawler indexes on the prerendered page anyway.
    const readme = page.getByRole('region', { name: 'README' });
    await expect(readme).toContainText(BARE_TOOL.readme_excerpt.replace(/\s+/g, ' ').trim());
  });

  test('related tools are same-kind, different-owner, and navigate cleanly', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${K9S.full_name}`);

    const related = page.getByRole('region', { name: 'Related' });
    await expect(related).toBeVisible();

    const link = related.getByRole('link').first();
    const href = (await link.getAttribute('href'))!;
    expect(href).not.toContain(`/${K9S.owner}/`);
    await link.click();

    await expect(page).toHaveURL(href);
    // The README and the heading must belong to the same repository at every moment: state
    // carrying the repo it describes is what closes the window where A's docs sit under B's
    // title. Attributing one stranger's documentation to another is the claim §1 forbids.
    await expect(toolHeading(page)).toHaveText(href.split('/').pop()!);
    await expect(page.getByRole('region', { name: 'README' })).not.toContainText('K9s');
  });

  test('an archived project is reachable by link and says it is archived', async ({
    page,
    visit,
  }) => {
    await visit(`/tools/${ARCHIVED.full_name}`);

    // Colour alone never carries this: the pill ships an icon *and* the word (§9), which is
    // why the accessible text reads "⚠ Archived" rather than relying on amber.
    await expect(page.getByText(/⚠\s*Archived/)).toBeVisible();
    await expect(toolHeading(page)).toHaveText(ARCHIVED.name);
  });

  test('a repository that is not in the corpus is a 404, not a blank page', async ({
    page,
    visit,
  }) => {
    await visit('/tools/nobody/does-not-exist');

    await expect(page.getByRole('heading', { name: 'Not found', level: 1 })).toBeVisible();
  });
});
