import { applySettings, createAdminClient } from '../index';

/** `mise run search:settings` — idempotent, safe to run on every deploy. */
const client = createAdminClient();
await applySettings(client);
console.log(`applied index settings to ${process.env.MEILI_HOST ?? 'http://localhost:7700'}`);
