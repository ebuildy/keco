import { loadEnv } from './env';
import { warmReadmeRenderer } from './readme/render';
import { loadPrerenderManifest, resolveDist } from './plugins/static';
import { build } from './server';

/**
 * The process entry, and the only place that listens. Everything else builds an instance and
 * injects into it.
 */
const env = loadEnv();
const app = await build({
  env,
  // Read once at boot. A prerender run after this process started is not picked up until it
  // restarts — which is correct, because the HTML files it wrote change at the same moment.
  prerendered: await loadPrerenderManifest(resolveDist(env.WEB_DIST)),
});

/** A close that neither hangs the process nor exits it silently non-zero. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function shutdown(signal: NodeJS.Signals): void {
  app.log.info({ signal }, 'shutting down');

  const timeout = setTimeout(() => {
    app.log.error({ signal, timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  app
    .close()
    .then(() => {
      clearTimeout(timeout);
      process.exit(0);
    })
    .catch((error: unknown) => {
      clearTimeout(timeout);
      app.log.error({ signal, error }, 'shutdown failed');
      process.exit(1);
    });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown(signal));
}

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ dist: resolveDist(env.WEB_DIST) }, 'serving the portal');

// After listen, deliberately: readiness must not wait on it, but the first caller of
// /api/readme should not be the one who pays Shiki's grammar load either (see render.ts).
void warmReadmeRenderer().then(() => app.log.debug('readme renderer warm'));
