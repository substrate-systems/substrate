import { NextRequest } from 'next/server';
import { errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireAuth } from '@/lib/hosted-backup/auth-middleware';
import {
  findUserById,
  getSubscriptionEntitlement,
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
    // Re-read entitlement from the DB rather than trusting the JWT claim
    // (claim is a hint; DB is authoritative per contract §10). The
    // effective status already applies the 14-day past_due grace cutoff.
    const ent = await getSubscriptionEntitlement(user.id);
    const responseBody: AccountMeResponse = {
      userId: user.id,
      email: user.email,
      createdAt: user.created_at,
      subscriptionStatus: ent.effectiveStatus,
      plan: ent.plan,
      currentPeriodEnd: ent.currentPeriodEnd,
      gracePeriodEndsAt: ent.gracePeriodEndsAt,
      paddleSubscriptionId: ent.paddleSubscriptionId,
      paddleCustomerId: ent.paddleCustomerId,
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup account/me] unhandled:', err);
    }
    return errorResponse(err);
  }
}
