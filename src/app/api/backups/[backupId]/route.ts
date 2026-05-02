import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireReadAccess } from '@/lib/hosted-backup/auth-middleware';
import { deleteBackup } from '@/lib/hosted-backup/storage';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';

export const runtime = 'nodejs';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string }> },
) {
  try {
    const { userId } = await requireReadAccess(req);
    const { backupId } = await params;
    if (!backupId) throw errors.badRequest('backupId is required');
    const result = await deleteBackup({ userId, backupId });
    if (!result.removed) throw errors.notFound('backup not found');
    return jsonWithApiVersion(
      { ok: true, r2PrefixForPurge: result.r2Prefix },
      200,
    );
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup backups DELETE] unhandled:', err);
    }
    return errorResponse(err);
  }
}
