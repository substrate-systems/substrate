import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { mintAccessToken } from '@/lib/hosted-backup/jwt';
import { rotateRefreshToken } from '@/lib/hosted-backup/refresh';
import { getSubscriptionStatus } from '@/lib/hosted-backup/db';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type { RefreshResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    let body: { refreshToken?: unknown };
    try {
      body = (await req.json()) as { refreshToken?: unknown };
    } catch {
      throw errors.badRequest('invalid JSON body');
    }
    if (typeof body.refreshToken !== 'string' || body.refreshToken.length === 0) {
      throw errors.badRequest('refreshToken is required');
    }

    const issued = await rotateRefreshToken(body.refreshToken);
    const subscriptionStatus = await getSubscriptionStatus(issued.row.user_id);
    const access = await mintAccessToken({
      userId: issued.row.user_id,
      subscriptionStatus,
    });

    const responseBody: RefreshResponse = {
      accessToken: access.token,
      refreshToken: issued.token,
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup refresh] unhandled:', err);
    }
    return errorResponse(err);
  }
}
