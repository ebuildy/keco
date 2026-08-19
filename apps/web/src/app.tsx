import { Route, Routes } from 'react-router';
import { HomePage } from './routes/home';
import { NotFoundPage } from './routes/not-found';

/**
 * The route tree, and the one thing both `main.tsx` and `prerender/index.ts` import. Keeping
 * it in a single component is what makes the prerendered HTML and the client render the same
 * tree — a second, hand-written rendering of a page is a second thing to keep in sync (§9).
 *
 * Routes are added in Tasks 12–14.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
