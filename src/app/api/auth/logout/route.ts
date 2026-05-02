import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { revokeRefreshTokenByValue } from '@/lib/hosted-backup/refresh';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';

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
    await revokeRefreshTokenByValue(body.refreshToken);
    return jsonWithApiVersion({ ok: true }, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup logout] unhandled:', err);
    }
    return errorResponse(err);
  }
}
