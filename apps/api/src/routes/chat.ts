import type { FastifyPluginAsync } from 'fastify';

/**
 * Chatbot (v2, AGENTS.md §11) — strictly retrieval-grounded, and the rules are not negotiable:
 *   1. retrieve first (Meilisearch hybrid), answer only from what came back
 *   2. never name a tool outside the retrieved set; never emit an install command that is not
 *      in that tool's verified install_methods — the model does not write shell commands from
 *      memory
 *   3. every recommendation renders as a tool card linking to its Keco page
 *   4. weak retrieval ⇒ say so, offer "possibly related", do not pad
 *   5. flag archived or stale suggestions
 *   6. stateless, no history, no PII, per-IP rate limit, hard token budget per request
 *   7. log (query, retrieved_ids, answer) to `traces`; evals live in packages/query/evals
 */
export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', async (_request, reply) => reply.code(501).send({ error: 'not_implemented' }));
};
