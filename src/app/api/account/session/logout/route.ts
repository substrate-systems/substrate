import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireAccountSession } from '@/lib/hosted-backup/account-middleware';
import {
  ACCOUNT_SESSION_COOKIE,
  invalidateAccountSession,
} from '@/lib/hosted-backup/browser-session';
import { withApiVersion } from '@/lib/hosted-backup/api-version';
import {
  errorResponse,
  HostedBackupError,
} from '@/lib/hosted-backup/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Ends the cookie-authenticated /account session. Invalidates the row in
// `account_sessions` so the cookie can't be reused after logout.
export async function POST(_req: NextRequest) {
  try {
    const { cookieSessionId } = await requireAccountSession(await cookies());
    await invalidateAccountSession(cookieSessionId);
    const res = new NextResponse(null, { status: 204 });
    res.cookies.set(ACCOUNT_SESSION_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    return withApiVersion(res);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup account/session/logout] unhandled:', err);
    }
    return errorResponse(err);
  }
}
