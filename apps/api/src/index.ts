import { loadEnv } from './env';
import { build } from './server';

/**
 * The process entry, and the only place that listens. Everything else builds an instance and
 * injects into it.
 */
const env = loadEnv();
const app = await build({ env });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
