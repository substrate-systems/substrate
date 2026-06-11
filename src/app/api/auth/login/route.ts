import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { verifyServerSecret } from '@/lib/hosted-backup/kdf';
import { mintAccessToken } from '@/lib/hosted-backup/jwt';
import { issueFreshChain } from '@/lib/hosted-backup/refresh';
import {
  findUserByEmail,
  getAuthCredentials,
  getSubscriptionStatus,
} from '@/lib/hosted-backup/db';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import {
  RATE_LIMITS,
  clientIpFrom,
  enforceRateLimit,
  recordRateLimitEvent,
} from '@/lib/hosted-backup/rate-limit';
import type {
  LoginStep1Response,
  LoginStep2Response,
} from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

type Body = {
  email?: unknown;
  serverPassword?: unknown;
};

export async function POST(req: NextRequest) {
  try {
    // Failures-only budgets: unknown-email probes and wrong passwords are
    // recorded; a successful step 1 or step 2 consumes nothing.
    const ip = clientIpFrom(req);
    await enforceRateLimit(RATE_LIMITS.loginPerIp, ip);

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      throw errors.badRequest('invalid JSON body');
    }
    if (typeof body.email !== 'string' || body.email.length === 0) {
      throw errors.badRequest('email is required');
    }
    const email = body.email.trim();
    const accountKey = email.toLowerCase();
    const isStep2 = typeof body.serverPassword === 'string';
    if (isStep2) {
      await enforceRateLimit(RATE_LIMITS.loginPerAccount, accountKey);
    }
    const recordFailure = async () => {
      await recordRateLimitEvent(RATE_LIMITS.loginPerIp, ip);
      await recordRateLimitEvent(RATE_LIMITS.loginPerAccount, accountKey);
    };

    const user = await findUserByEmail(email);
    if (!user) {
      await recordFailure();
      throw errors.emailNotFound();
    }

    const creds = await getAuthCredentials(user.id);
    if (!creds) {
      // Should not happen — auth_credentials is inserted in the same flow as users.
      console.error(
        '[hosted-backup login] missing credentials for existing user',
        user.id,
      );
      await recordFailure();
      throw errors.emailNotFound();
    }

    if (!isStep2) {
      // Step 1: pre-handshake. Return salt + kdfParams.
      const responseBody: LoginStep1Response = {
        salt: Buffer.from(creds.client_salt).toString('base64'),
        kdfParams: creds.kdf_params,
      };
      return jsonWithApiVersion(responseBody, 200);
    }

    // Step 2: complete.
    const serverPasswordRaw = body.serverPassword as string;
    let serverPassword: Uint8Array;
    try {
      serverPassword = new Uint8Array(Buffer.from(serverPasswordRaw, 'base64'));
    } catch {
      throw errors.badRequest('serverPassword is not valid base64');
    }
    if (serverPassword.length !== 32) {
      throw errors.badRequest('serverPassword must be 32 bytes');
    }

    const ok = await verifyServerSecret(creds.server_password_hash, serverPassword);
    if (!ok) {
      await recordFailure();
      throw errors.invalidCredentials();
    }

    const subscriptionStatus = await getSubscriptionStatus(user.id);
    const access = await mintAccessToken({
      userId: user.id,
      subscriptionStatus,
    });
    const refresh = await issueFreshChain(user.id);

    const responseBody: LoginStep2Response = {
      userId: user.id,
      accessToken: access.token,
      refreshToken: refresh.token,
      wrappedDEK: Buffer.from(creds.wrapped_dek).toString('base64'),
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup login] unhandled:', err);
    }
    return errorResponse(err);
  }
}
