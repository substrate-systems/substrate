import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireReadAccess } from '@/lib/hosted-backup/auth-middleware';
import { softDeleteVersion } from '@/lib/hosted-backup/storage';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';

export const runtime = 'nodejs';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string; versionId: string }> },
) {
  try {
    const { userId } = await requireReadAccess(req);
    const { backupId, versionId } = await params;
    if (!backupId || !versionId) {
      throw errors.badRequest('backupId and versionId are required');
    }
    await softDeleteVersion({ userId, backupId, versionId });
    return jsonWithApiVersion({ ok: true }, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup version DELETE] unhandled:', err);
    }
    return errorResponse(err);
  }
}
