import { NextRequest } from 'next/server';
import {
  errors,
  errorResponse,
  HostedBackupError,
} from '@/lib/hosted-backup/errors';
import { validateKdfParams, hashServerSecret } from '@/lib/hosted-backup/kdf';
import { mintAccessToken } from '@/lib/hosted-backup/jwt';
import { issueFreshChain } from '@/lib/hosted-backup/refresh';
import {
  getSubscriptionStatus,
  insertAuthCredentials,
} from '@/lib/hosted-backup/db';
import {
  consumeClaimToken,
  verifyClaimToken,
} from '@/lib/hosted-backup/claim-tokens';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  serverPassword?: unknown;
  salt?: unknown;
  kdfParams?: unknown;
  wrappedDEK?: unknown;
  recoveryKeyVerifier?: unknown;
  recoveryKeyWrappedDEK?: unknown;
};

type ClaimResponse = {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  subscriptionStatus: string;
};

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

function extractBearerToken(req: NextRequest): string {
  const header =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) {
    throw errors.unauthenticated(
      'expected Authorization: Bearer <claimToken>',
    );
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
    const claimToken = extractBearerToken(req);

    // Pre-flight verification gives a clean 401/409 distinction before we
    // attempt the atomic consume (which can only report a generic match-or-
    // race outcome). The consume below is still the source of truth for the
    // single-use semantics.
    const pre = await verifyClaimToken(claimToken);
    if (pre.kind === 'invalid') throw errors.claimTokenInvalid();
    if (pre.kind === 'expired') throw errors.claimTokenExpired();
    if (pre.kind === 'consumed') throw errors.claimTokenConsumed();

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      throw errors.badRequest('invalid JSON body');
    }

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

    // Single-use consume. If two simultaneous claims race, the loser sees
    // a 'race' result and we return CLAIM_TOKEN_CONSUMED — the winner
    // proceeds to insertAuthCredentials.
    const consume = await consumeClaimToken(claimToken);
    if (consume.kind === 'invalid') throw errors.claimTokenInvalid();
    if (consume.kind === 'expired') throw errors.claimTokenExpired();
    if (consume.kind === 'race') throw errors.claimTokenConsumed();

    const serverPasswordHash = await hashServerSecret(serverPassword);
    const recoveryKeyVerifier = await hashServerSecret(recoveryKeyProof);

    try {
      await insertAuthCredentials({
        userId: consume.userId,
        serverPasswordHash,
        clientSalt,
        kdfParams,
        wrappedDek,
        recoveryKeyVerifier,
        recoveryKeyWrappedDek,
      });
    } catch (err: unknown) {
      // Pre-account already had credentials attached — happens if the
      // webhook minted a second token after the user already claimed.
      // The token consume above succeeded, but the credentials write
      // collides on the unique constraint. Surface as already-consumed
      // from the caller's perspective.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
      ) {
        throw errors.claimTokenConsumed();
      }
      throw err;
    }

    const subscriptionStatus = await getSubscriptionStatus(consume.userId);
    const access = await mintAccessToken({
      userId: consume.userId,
      subscriptionStatus,
    });
    const refresh = await issueFreshChain(consume.userId);

    const responseBody: ClaimResponse = {
      userId: consume.userId,
      email: consume.email,
      accessToken: access.token,
      refreshToken: refresh.token,
      subscriptionStatus,
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup claim] unhandled:', err);
    }
    return errorResponse(err);
  }
}
