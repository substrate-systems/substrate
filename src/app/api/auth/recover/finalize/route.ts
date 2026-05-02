import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import {
  validateKdfParams,
  hashServerSecret,
} from '@/lib/hosted-backup/kdf';
import { mintAccessToken, verifyRecoveryToken } from '@/lib/hosted-backup/jwt';
import { issueFreshChain } from '@/lib/hosted-backup/refresh';
import {
  getSubscriptionStatus,
  revokeAllRefreshChainsForUser,
  updateAuthCredentialsForRecovery,
} from '@/lib/hosted-backup/db';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type { RecoverFinalizeResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

type Body = {
  recoveryToken?: unknown;
  newServerPassword?: unknown;
  newSalt?: unknown;
  newKdfParams?: unknown;
  newWrappedDEK?: unknown;
};

function decodeBase64(field: string, value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw errors.badRequest(`${field} is required`);
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export async function POST(req: NextRequest) {
  try {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      throw errors.badRequest('invalid JSON body');
    }
    if (
      typeof body.recoveryToken !== 'string' ||
      body.recoveryToken.length === 0
    ) {
      throw errors.badRequest('recoveryToken is required');
    }

    let userId: string;
    try {
      ({ userId } = await verifyRecoveryToken(body.recoveryToken));
    } catch (err) {
      if (err instanceof HostedBackupError && err.code === 'TOKEN_EXPIRED') {
        throw errors.recoveryTokenExpired();
      }
      throw err;
    }

    const newKdfParams = validateKdfParams(body.newKdfParams);
    const newServerPassword = decodeBase64('newServerPassword', body.newServerPassword);
    if (newServerPassword.length !== 32) {
      throw errors.badRequest('newServerPassword must be 32 bytes');
    }
    const newSalt = decodeBase64('newSalt', body.newSalt);
    if (newSalt.length !== 16) {
      throw errors.badRequest('newSalt must be 16 bytes');
    }
    const newWrappedDek = decodeBase64('newWrappedDEK', body.newWrappedDEK);

    const newServerPasswordHash = await hashServerSecret(newServerPassword);

    await updateAuthCredentialsForRecovery({
      userId,
      serverPasswordHash: newServerPasswordHash,
      clientSalt: newSalt,
      kdfParams: newKdfParams,
      wrappedDek: newWrappedDek,
    });
    await revokeAllRefreshChainsForUser(userId);

    const subscriptionStatus = await getSubscriptionStatus(userId);
    const access = await mintAccessToken({ userId, subscriptionStatus });
    const refresh = await issueFreshChain(userId);

    const responseBody: RecoverFinalizeResponse = {
      accessToken: access.token,
      refreshToken: refresh.token,
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup recover/finalize] unhandled:', err);
    }
    return errorResponse(err);
  }
}
