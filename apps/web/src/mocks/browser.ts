import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/**
 * The only module that imports `msw/browser`. Kept apart from handlers.ts so the handlers
 * stay loadable under the node test environment.
 */
export const worker = setupWorker(...handlers);
