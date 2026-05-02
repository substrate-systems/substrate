import { NextRequest } from 'next/server';
import { errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireAuth } from '@/lib/hosted-backup/auth-middleware';
import {
  findUserById,
  getSubscriptionStatus,
} from '@/lib/hosted-backup/db';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type { AccountMeResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireAuth(req);
    const user = await findUserById(userId);
    if (!user) {
      // User row deleted while a token was still in flight. Surface as 401.
      throw new HostedBackupError({
        code: 'UNAUTHENTICATED',
        status: 401,
        message: 'user no longer exists',
      });
    }
    // Re-read subscription status from the DB rather than trusting the JWT
    // claim (claim is a hint; DB is authoritative per contract §10).
    const subscriptionStatus = await getSubscriptionStatus(user.id);
    const responseBody: AccountMeResponse = {
      userId: user.id,
      email: user.email,
      subscriptionStatus,
      createdAt: user.created_at,
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup account/me] unhandled:', err);
    }
    return errorResponse(err);
  }
}
