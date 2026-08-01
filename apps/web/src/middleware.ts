import { NextResponse, type NextRequest } from 'next/server';

/**
 * Guards /admin (§12). Middleware is a gate, not authorization: every server action and
 * command handler re-checks the session itself.
 */
export function middleware(_request: NextRequest) {
  // TODO(admin): Auth.js session check against ADMIN_LOGINS. Until it exists, /admin is
  // closed unless explicitly opened for local development.
  if (process.env.ADMIN_LOGINS && process.env.NODE_ENV !== 'production') return NextResponse.next();
  return new NextResponse('unauthorized', { status: 401 });
}

export const config = { matcher: ['/admin/:path*'] };
