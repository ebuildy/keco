import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

const tree = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

/**
 * Prerendered tool pages arrive with markup already inside #root and their data on
 * `window.__KECO_DATA__`, so React hydrates over what the crawler saw (§9). Every other route
 * gets the empty shell and mounts fresh. Calling hydrateRoot on an empty container logs a
 * mismatch, and createRoot on a filled one throws the prerendered HTML away — so the branch
 * is on the container, not on the route.
 */
const render = (): void => {
  if (container.firstChild) hydrateRoot(container, tree);
  else createRoot(container).render(tree);
};

/**
 * The development mock backend (docs/superpowers/specs/2026-08-23-portal-mock-backend-design.md).
 *
 * `import.meta.env.DEV` is first and is not optional: Vite replaces it with the literal
 * `false` in a production build, so Rollup eliminates this branch and the dynamic import with
 * it, and nothing reachable from ./mocks/start is emitted. VITE_MOCK is only ever a second
 * condition narrowing an already dev-only branch — a runtime flag alone is something a
 * deployment environment could set.
 */
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  void import('./mocks/start')
    .then(({ startMocks }) => startMocks())
    .then(render);
} else {
  render();
}
