import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { verifyServerSecret } from '@/lib/hosted-backup/kdf';
import { mintRecoveryToken } from '@/lib/hosted-backup/jwt';
import {
  findUserByEmail,
  getAuthCredentials,
} from '@/lib/hosted-backup/db';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type { RecoverResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

type Body = {
  email?: unknown;
  recoveryKeyProof?: unknown;
};

export async function POST(req: NextRequest) {
  try {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      throw errors.badRequest('invalid JSON body');
    }
    if (typeof body.email !== 'string' || body.email.length === 0) {
      throw errors.badRequest('email is required');
    }
    if (
      typeof body.recoveryKeyProof !== 'string' ||
      body.recoveryKeyProof.length === 0
    ) {
      throw errors.badRequest('recoveryKeyProof is required');
    }
    const email = body.email.trim();

    let recoveryKeyProof: Uint8Array;
    try {
      recoveryKeyProof = new Uint8Array(
        Buffer.from(body.recoveryKeyProof, 'base64'),
      );
    } catch {
      throw errors.badRequest('recoveryKeyProof is not valid base64');
    }
    if (recoveryKeyProof.length !== 32) {
      throw errors.badRequest('recoveryKeyProof must be 32 bytes');
    }

    const user = await findUserByEmail(email);
    if (!user) throw errors.invalidRecoveryKey();
    const creds = await getAuthCredentials(user.id);
    if (!creds) throw errors.invalidRecoveryKey();

    const ok = await verifyServerSecret(
      creds.recovery_key_verifier,
      recoveryKeyProof,
    );
    if (!ok) throw errors.invalidRecoveryKey();

    const recovery = await mintRecoveryToken({ userId: user.id });

    const responseBody: RecoverResponse = {
      recoveryToken: recovery.token,
      recoveryKeyWrappedDEK: Buffer.from(creds.recovery_key_wrapped_dek).toString(
        'base64',
      ),
    };
    return jsonWithApiVersion(responseBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup recover] unhandled:', err);
    }
    return errorResponse(err);
  }
}
