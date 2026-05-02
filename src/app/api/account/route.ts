import { NextRequest } from 'next/server';
import { errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireAuth } from '@/lib/hosted-backup/auth-middleware';
import { deleteAccount } from '@/lib/hosted-backup/account-deletion';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';

export const runtime = 'nodejs';

export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await requireAuth(req);
    const result = await deleteAccount(userId);
    if (!result.deleted) {
      // The user row was already gone (concurrent delete). Treat as success.
      console.warn(
        '[hosted-backup account DELETE] user row not found at cascade time:',
        userId,
      );
    }
    return jsonWithApiVersion(
      {
        ok: true,
        paddleCancelled: result.paddleCancelled,
        r2PrefixForPurge: result.r2PrefixForPurge,
      },
      200,
    );
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup account DELETE] unhandled:', err);
    }
    return errorResponse(err);
  }
}
