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
if (container.firstChild) hydrateRoot(container, tree);
else createRoot(container).render(tree);
