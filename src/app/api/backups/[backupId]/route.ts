import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireReadAccess } from '@/lib/hosted-backup/auth-middleware';
import { deleteBackup, updateBackup } from '@/lib/hosted-backup/storage';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';

export const runtime = 'nodejs';

// Cap the human label length. Identity is the UUID; the name is a display
// label, so a generous-but-bounded cap is enough to stop abuse.
const MAX_BACKUP_NAME_LEN = 200;

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

/**
 * Update a backup's mutable metadata (rename today; partial body so future
 * fields are additive). Uses requireReadAccess — managing an existing backup
 * is allowed in any non-`none` subscription state, mirroring DELETE; rename is
 * strictly less destructive than delete. Identity stays the UUID; only the
 * display label changes.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string }> },
) {
  try {
    const { userId } = await requireReadAccess(req);
    const { backupId } = await params;
    if (!backupId) throw errors.badRequest('backupId is required');

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw errors.badRequest('invalid JSON body');
    }

    const rawName = (body as { name?: unknown } | null)?.name;
    if (typeof rawName !== 'string') {
      throw errors.badRequest('name is required');
    }
    const name = rawName.trim();
    if (!name) throw errors.badRequest('name must not be empty');
    if (name.length > MAX_BACKUP_NAME_LEN) {
      throw errors.badRequest(
        `name must be at most ${MAX_BACKUP_NAME_LEN} characters`,
      );
    }

    const updated = await updateBackup({ userId, backupId, patch: { name } });
    return jsonWithApiVersion(updated, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup backups PATCH] unhandled:', err);
    }
    return errorResponse(err);
  }
}
