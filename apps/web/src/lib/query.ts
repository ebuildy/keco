import { createQueryClient } from '@keco/query';

/**
 * One query client for the whole read side (§11). The portal, REST and MCP all go through
 * @keco/query — never straight to Meilisearch, and never to a write-side package.
 */
export const query = createQueryClient();
