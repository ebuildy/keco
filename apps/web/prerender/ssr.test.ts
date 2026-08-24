import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app';

/**
 * The route tree must render in Node, where there is no `document` and no `localStorage`.
 *
 * `prerender/index.ts` renders every one of the top 1000 tool pages through `renderToString`,
 * so a component that reads the DOM during render does not fail gracefully — it fails
 * `mise run build`, and it fails it at the step that produces the entire SEO surface (§9).
 *
 * The live example is `ThemeToggle`: it calls `currentTheme()`, which touches both globals, and
 * it must only ever do so inside `useEffect`. `renderToString` does not run effects, so this
 * test passes exactly when that constraint holds. Moving the call into the render body — or
 * into a `useState` initialiser, which looks harmless — makes it fail here rather than in CI's
 * build step with a stack trace pointing at react-dom.
 *
 * Kept in `prerender/` rather than `src/` on purpose: this is a property of the build, and the
 * default vitest environment here is Node, which is the whole point. A jsdom environment would
 * supply a `document` and silently stop testing anything.
 */
const render = (location: string): string =>
  renderToString(createElement(StaticRouter, { location }, createElement(App)));

describe('the route tree under renderToString', () => {
  it.each(['/', '/search?q=ingress', '/tools/kubernetes/ingress-nginx', '/nope'])(
    'renders %s without touching the DOM',
    (location) => {
      expect(() => render(location)).not.toThrow();
    },
  );

  it('puts the shell around every route, so a crawler sees the navigation', () => {
    const html = render('/');
    expect(html).toContain('Skip to content');
    expect(html).toContain('Keco');
  });

  /**
   * The `/` shortcut and every Escape/arrow path address the search field by id, so the whole
   * contract rests on exactly one element carrying it. It previously did not: the header field
   * rendered at all widths while a second, `lg:hidden` copy on the search page held the ref, so
   * `focus()` ran against a `display:none` element and `/` was inert on every desktop screen.
   *
   * Counting per route is what catches both halves — a duplicate (two fields, ambiguous target)
   * and a disappearance (no field, silent no-op).
   */
  it.each([
    ['/', 1],
    ['/search?q=ingress', 1],
    ['/tools/kubernetes/ingress-nginx', 1],
    ['/nope', 1],
  ])('mounts exactly one search field on %s', (location, expected) => {
    const matches = render(location).match(/id="site-search"/g) ?? [];
    expect(matches).toHaveLength(expected);
  });

  it('renders the theme toggle in its light state, since effects have not run', () => {
    // Not an aesthetic assertion: it pins the fact that the toggle derives nothing from the
    // environment during render. If this ever reads "Switch to the light theme" server-side,
    // something started resolving the real theme too early.
    expect(render('/')).toContain('Switch to the dark theme');
  });
});
