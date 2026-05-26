import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireAccountSession } from '@/lib/hosted-backup/account-middleware';
import {
  ACCOUNT_SESSION_COOKIE,
  invalidateAccountSession,
} from '@/lib/hosted-backup/browser-session';
import { deleteAccount } from '@/lib/hosted-backup/account-deletion';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import {
  errorResponse,
  HostedBackupError,
} from '@/lib/hosted-backup/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cookie-authenticated wrapper around DELETE /api/account so the /account
// web page can delete via the same lib function without dual-auth on the
// canonical route. Sibling rather than middleware: keeps the engine-side
// bearer-only flow untouched.
export async function POST(_req: NextRequest) {
  try {
    const { userId, cookieSessionId } = await requireAccountSession(
      await cookies(),
    );
    const result = await deleteAccount(userId);
    await invalidateAccountSession(cookieSessionId);
    const res = jsonWithApiVersion(
      {
        ok: true,
        paddleCancelled: result.paddleCancelled,
        r2PrefixForPurge: result.r2PrefixForPurge,
      },
      200,
    );
    res.cookies.set(ACCOUNT_SESSION_COOKIE, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    return res;
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup account/web-delete] unhandled:', err);
    }
    return errorResponse(err);
  }
}
