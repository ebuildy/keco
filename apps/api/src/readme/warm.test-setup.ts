import { warmReadmeRenderer } from './render';

/**
 * Shiki loads its grammars and themes on the first render. Under a full-suite run the
 * workers compete for CPU and that first call has been measured at 6.6 s — past vitest's
 * 5 s default — which failed whichever test happened to render first, not the slow code.
 *
 * Paying it here moves the cost outside every test's clock. One warm-up per worker.
 */
await warmReadmeRenderer();
