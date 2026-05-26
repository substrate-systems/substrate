import { NextRequest, NextResponse } from 'next/server';
import { redeemBrowserSession } from '@/lib/hosted-backup/browser-session';
import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_MAX_AGE_S,
} from '@/lib/hosted-backup/browser-session';
import { withApiVersion } from '@/lib/hosted-backup/api-version';
import {
  errorResponse,
  HostedBackupError,
  errors,
} from '@/lib/hosted-backup/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Trades the 60s handoff JWT for an HttpOnly session cookie. Called by the
// `/account` server component on the first hit with `?session=<token>`.
// Burns the JWT's jti (single-use); replays return BROWSER_SESSION_CONSUMED.
//
// Body: `{ token: string }`. Response: 204 with Set-Cookie. See
// hosted-backup-contract.md §5.
export async function POST(req: NextRequest) {
  try {
    let token: string | undefined;
    try {
      const body = (await req.json()) as { token?: unknown };
      token = typeof body?.token === 'string' ? body.token : undefined;
    } catch {
      throw errors.badRequest('expected JSON body with `token` field');
    }
    if (!token) throw errors.badRequest('missing `token` field');

    const { cookieSessionId } = await redeemBrowserSession(token);

    const res = new NextResponse(null, { status: 204 });
    res.cookies.set(ACCOUNT_SESSION_COOKIE, cookieSessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ACCOUNT_SESSION_MAX_AGE_S,
      path: '/',
    });
    return withApiVersion(res);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup browser-session/redeem] unhandled:', err);
    }
    return errorResponse(err);
  }
}
