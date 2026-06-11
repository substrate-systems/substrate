import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { validateKdfParams, hashServerSecret } from '@/lib/hosted-backup/kdf';
import { mintAccessToken } from '@/lib/hosted-backup/jwt';
import { issueFreshChain } from '@/lib/hosted-backup/refresh';
import {
  findUserByEmail,
  insertUser,
  insertAuthCredentials,
  getSubscriptionStatus,
  userHasAuthCredentials,
} from '@/lib/hosted-backup/db';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import {
  RATE_LIMITS,
  clientIpFrom,
  enforceRateLimit,
  recordRateLimitEvent,
} from '@/lib/hosted-backup/rate-limit';
import type {
  SignupRequest,
  SignupResponse,
} from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

function decodeBase64(field: string, value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw errors.badRequest(`${field} is required`);
  }
  try {
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    throw errors.badRequest(`${field} is not valid base64`);
  }
}

function isValidEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  // Cheap shape check: presence of @ and . past it. Real validation happens
  // at email-verify time (deferred to v1.x). citext unique enforces uniqueness.
  const atIdx = email.indexOf('@');
  return atIdx > 0 && email.lastIndexOf('.') > atIdx;
}

export async function POST(req: NextRequest) {
  try {
    // Every shape-valid attempt counts (successes included) — account-spam
    // is the threat here, not credential guessing.
    const ip = clientIpFrom(req);
    await enforceRateLimit(RATE_LIMITS.signupPerIp, ip);

    let body: SignupRequest;
    try {
      body = (await req.json()) as SignupRequest;
    } catch {
      throw errors.badRequest('invalid JSON body');
    }

    if (!isValidEmail(body.email)) {
      throw errors.badRequest('email is invalid');
    }
    const email = body.email.trim();
    await recordRateLimitEvent(RATE_LIMITS.signupPerIp, ip);

    const kdfParams = validateKdfParams(body.kdfParams);
    const serverPassword = decodeBase64('serverPassword', body.serverPassword);
    if (serverPassword.length !== 32) {
      throw errors.badRequest('serverPassword must be 32 bytes');
    }
    const clientSalt = decodeBase64('salt', body.salt);
    if (clientSalt.length !== 16) {
      throw errors.badRequest('salt must be 16 bytes');
    }
    const wrappedDek = decodeBase64('wrappedDEK', body.wrappedDEK);
    const recoveryKeyProof = decodeBase64(
      'recoveryKeyVerifier',
      body.recoveryKeyVerifier,
    );
    const recoveryKeyWrappedDek = decodeBase64(
      'recoveryKeyWrappedDEK',
      body.recoveryKeyWrappedDEK,
    );

    const existing = await findUserByEmail(email);
    if (existing) {
      // Distinguish pre-account (users row without auth_credentials, minted by
      // the Paddle webhook for an anonymous marketing-page checkout) from a
      // fully-credentialed user. Pre-accounts MUST be claimed via
      // POST /api/auth/claim with the email-link token — otherwise an attacker
      // who learns the buyer's email could hijack the subscription by racing
      // to set credentials here.
      const hasCreds = await userHasAuthCredentials(existing.id);
      throw hasCreds ? errors.emailTaken() : errors.pendingClaim();
    }

    const serverPasswordHash = await hashServerSecret(serverPassword);
    const recoveryKeyVerifier = await hashServerSecret(recoveryKeyProof);

    let user;
    try {
      user = await insertUser(email);
    } catch (err: unknown) {
      // Unique-violation race — someone else just inserted this email.
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        throw errors.emailTaken();
      }
      throw err;
    }

    await insertAuthCredentials({
      userId: user.id,
      serverPasswordHash,
      clientSalt,
      kdfParams,
      wrappedDek,
      recoveryKeyVerifier,
      recoveryKeyWrappedDek,
    });

    const subscriptionStatus = await getSubscriptionStatus(user.id);
    const access = await mintAccessToken({
      userId: user.id,
      subscriptionStatus,
    });
    const refresh = await issueFreshChain(user.id);

    const responseBody: SignupResponse = {
      userId: user.id,
      accessToken: access.token,
      refreshToken: refresh.token,
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup signup] unhandled:', err);
    }
    return errorResponse(err);
  }
}
