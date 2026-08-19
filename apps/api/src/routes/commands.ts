import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { constantTimeEquals } from '../auth';
import type { Env } from '../env';
import { hasAdminSession } from '../session';

/**
 * Commands (AGENTS.md §11, §12): the only write path on the read side, and it writes to the
 * *write* model — it appends a journal event or resets a checkpoint, then returns. It never
 * touches Meilisearch and it never does the work inline.
 *
 * A handler here that loops over repos is always a bug (§14): long work cannot run inside a
 * request, so handlers enqueue and workers execute.
 *
 * Auth is an admin session OR `Bearer $COMMAND_TOKEN`, compared in constant time. No CORS.
 */
const COMMANDS = ['recrawl', 'reanalyze', 'reproject', 'rebuild', 'rollback'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

// Anchored to the exact `Bearer <token>` shape §12 documents. A `.replace(/^Bearer\s+/i, '')`
// here would leave a header untouched when the prefix is absent, so a bare
// `Authorization: <token>` (no scheme) would authenticate too — widening what counts as a
// credential beyond what's documented. No match ⇒ no credential, never a fallback to the raw
// header value.
const BEARER_TOKEN = /^Bearer (.+)$/i;

function bearerToken(header: string | undefined): string {
  const match = header ? BEARER_TOKEN.exec(header) : null;
  return match?.[1] ?? '';
}

function authorized(request: FastifyRequest, env: Env): boolean {
  // Re-checked here, inside the handler's plugin, rather than trusted from a hook (§12).
  if (hasAdminSession(request)) return true;
  return constantTimeEquals(bearerToken(request.headers.authorization), env.COMMAND_TOKEN ?? '');
}

export const commandRoutes: FastifyPluginAsync<{ env: Env }> = async (app, options) => {
  const { env } = options;

  app.post<{ Params: { command: string } }>('/:command', async (request, reply) => {
    if (!authorized(request, env)) return reply.code(401).send({ error: 'unauthorized' });

    const { command } = request.params;
    if (!isCommand(command)) {
      return reply.code(400).send({ error: 'unknown_command', commands: COMMANDS });
    }

    // TODO(commands): append the corresponding event to the journal (or reset a checkpoint)
    // through @keco/cache and return 202 immediately. The workers pick it up on their next
    // pass. The request body is currently ignored entirely — nothing here reads `repo` (or
    // any other field). When the journal append lands, that body becomes attacker-controlled
    // input flowing into a cache key on the *write* model, so it needs its own zod schema at
    // this boundary (§13) that rejects path-traversal shapes (`../`, absolute paths,
    // anything outside GitHub's own owner/repo character set) before it ever reaches
    // @keco/cache — the same discipline routes/readme.ts's Params schema already applies on
    // the read side. Tracked in ROADMAP.md under v1 → Read side → Backoffice.
    return reply.code(501).send({ error: 'not_implemented', command });
  });
};
