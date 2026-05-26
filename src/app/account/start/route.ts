import { NextRequest, NextResponse } from 'next/server';
import { redeemBrowserSession } from '@/lib/hosted-backup/browser-session';
import {
  ACCOUNT_SESSION_COOKIE,
  ACCOUNT_SESSION_MAX_AGE_S,
} from '@/lib/hosted-backup/browser-session';
import { HostedBackupError } from '@/lib/hosted-backup/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GUI → web Account Portal handoff landing page. The engine's
// `backup browser-session` command returns this URL with `?session=<jwt>`;
// the GUI opens it in the system browser. We swap the JWT for an HttpOnly
// cookie and 302 into `/account` so the URL bar doesn't retain the token.
//
// Failure modes flow into `/account?error=<code>` rather than a separate
// error page — the page can render a friendly state with a single mailto.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('session');
  if (!token) {
    return NextResponse.redirect(new URL('/account?error=NO_SESSION', req.url));
  }

  let cookieSessionId: string;
  try {
    const redeemed = await redeemBrowserSession(token);
    cookieSessionId = redeemed.cookieSessionId;
  } catch (err) {
    const code =
      err instanceof HostedBackupError ? err.code : 'INTERNAL_ERROR';
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup /account/start] unhandled:', err);
    }
    return NextResponse.redirect(
      new URL(`/account?error=${encodeURIComponent(code)}`, req.url),
    );
  }

  const res = NextResponse.redirect(new URL('/account', req.url));
  res.cookies.set(ACCOUNT_SESSION_COOKIE, cookieSessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ACCOUNT_SESSION_MAX_AGE_S,
    path: '/',
  });
  return res;
}
