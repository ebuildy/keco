import { MOCK_CORPUS, MOCK_SENTINEL } from './corpus/index';
import { worker } from './browser';

/**
 * Starts the development mock backend. Reached only from main.tsx's
 * `import.meta.env.DEV && VITE_MOCK === '1'` branch, which a production build eliminates.
 *
 * Loud, never degrading: a request the mock does not model must fail visibly rather than fall
 * through to a real or absent backend, and a worker that fails to register must throw rather
 * than silently leaving the app talking to nothing. Collapsing a misconfiguration into
 * plausible-looking data is exactly the failure searchErrorMessage() exists to avoid.
 */
export async function startMocks(): Promise<void> {
  await worker.start({
    onUnhandledRequest: 'error',
    quiet: true,
  });

  console.info(
    `%c[keco] mock backend active — ${MOCK_CORPUS.length} fabricated documents, no real data. (${MOCK_SENTINEL})`,
    'color:#b45309;font-weight:bold',
  );
}
