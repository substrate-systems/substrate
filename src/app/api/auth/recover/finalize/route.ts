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
  recoverFinalizeAtomic,
} from '@/lib/hosted-backup/db';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type { RecoverFinalizeResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

type Body = {
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

// Contract §6: recoveryToken arrives as Authorization: Bearer; the body
// carries only the new passphrase-derived material. The token is single-use
// — markRecoveryTokenUsed atomically rejects replays via a primary-key
// collision on recovery_tokens_used.
function extractBearerToken(req: NextRequest): string {
  const header =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) {
    throw errors.unauthenticated('expected Authorization: Bearer <recoveryToken>');
  }
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw errors.unauthenticated('expected Bearer scheme');
  }
  const token = header.slice('bearer '.length).trim();
  if (!token) throw errors.unauthenticated('empty Bearer token');
  return token;
}

export async function POST(req: NextRequest) {
  try {
    const recoveryToken = extractBearerToken(req);

    let userId: string;
    let jti: string;
    try {
      ({ userId, jti } = await verifyRecoveryToken(recoveryToken));
    } catch (err) {
      // Any verification failure on a recovery token (expired, malformed,
      // signature mismatch, wrong audience, missing claims) collapses to
      // RECOVERY_TOKEN_EXPIRED so the engine and GUI can surface a single
      // "your recovery session is over, start again" UX state. Contract §6.
      if (
        err instanceof HostedBackupError &&
        (err.code === 'TOKEN_EXPIRED' || err.code === 'INVALID_TOKEN')
      ) {
        throw errors.recoveryTokenExpired();
      }
      throw err;
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      throw errors.badRequest('invalid JSON body');
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

    // Atomic burn-and-update — rollback semantics close the crash window
    // between consuming the recovery token and rotating credentials.
    // Replays and concurrent finalize calls collide on the PK constraint
    // for recovery_tokens_used and surface as tokenAlreadyUsed.
    const { tokenAlreadyUsed } = await recoverFinalizeAtomic({
      jti,
      userId,
      serverPasswordHash: newServerPasswordHash,
      clientSalt: newSalt,
      kdfParams: newKdfParams,
      wrappedDek: newWrappedDek,
    });
    if (tokenAlreadyUsed) {
      throw errors.recoveryTokenExpired();
    }

    const subscriptionStatus = await getSubscriptionStatus(userId);
    const access = await mintAccessToken({ userId, subscriptionStatus });
    const refresh = await issueFreshChain(userId);

    const responseBody: RecoverFinalizeResponse = {
      userId,
      accessToken: access.token,
      refreshToken: refresh.token,
      subscriptionStatus,
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup recover/finalize] unhandled:', err);
    }
    return errorResponse(err);
  }
}
