import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireWriteAccess } from '@/lib/hosted-backup/auth-middleware';
import { commitVersionUpload } from '@/lib/hosted-backup/storage';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type { CommitVersionResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

/**
 * Second phase of a version push (contract §7, §8).
 *
 * `POST /api/backups/:backupId/versions` mints presigned URLs and records the
 * version; this endpoint is the client's statement that every chunk and the
 * manifest are actually in R2. Only now does the version become visible to
 * list/restore/quota, and only now is the retention cap applied — so a push
 * that fails midway leaves the previous good version untouched.
 *
 * Write-gated (`requireWriteAccess`) because it is the closing half of a
 * write, not a management operation: a user who may not create a version may
 * not publish one either.
 *
 * Idempotent — a second call returns the original `committedAt` with
 * `alreadyCommitted: true` and prunes nothing further.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string; versionId: string }> },
) {
  try {
    const { userId } = await requireWriteAccess(req);
    const { backupId, versionId } = await params;
    if (!backupId || !versionId) {
      throw errors.badRequest('backupId and versionId are required');
    }
    const result = await commitVersionUpload({ userId, backupId, versionId });
    const body: CommitVersionResponse = {
      versionId: result.versionId,
      committedAt: result.committedAt,
      alreadyCommitted: result.alreadyCommitted,
    };
    return jsonWithApiVersion(body, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup version commit POST] unhandled:', err);
    }
    return errorResponse(err);
  }
}
