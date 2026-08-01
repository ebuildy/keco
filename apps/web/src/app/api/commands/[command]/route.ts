import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * Commands (§10, §12): enqueue-only. These append an event or reset a checkpoint and
 * return immediately — they never do the work in the request. A `for` loop over 10k repos
 * in app/api is always a bug (§14).
 *
 * Auth: an admin session OR `Bearer $COMMAND_TOKEN`, compared in constant time. No CORS.
 */
export const runtime = 'nodejs';

const COMMANDS = ['recrawl', 'reanalyze', 'reproject', 'rebuild', 'rollback'] as const;
type Command = (typeof COMMANDS)[number];

function authorized(request: Request): boolean {
  const expected = process.env.COMMAND_TOKEN;
  if (!expected) return false;
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request, { params }: { params: Promise<{ command: string }> }) {
  // TODO(admin): also accept an authenticated admin session (Auth.js + ADMIN_LOGINS).
  // Re-check authorization here, inside the handler — middleware alone is not
  // authorization, and server actions are POST endpoints too (§12, §14).
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { command } = await params;
  if (!COMMANDS.includes(command as Command)) {
    return NextResponse.json({ error: 'unknown_command', commands: COMMANDS }, { status: 400 });
  }

  // TODO(admin): append the corresponding event to the journal (or reset a checkpoint)
  // and return 202 immediately. The workers pick it up on their next pass.
  return NextResponse.json({ error: 'not_implemented', command }, { status: 501 });
}
