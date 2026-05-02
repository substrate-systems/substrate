import { withApiVersion } from '@/lib/hosted-backup/api-version';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Stub for the deferred R2 garbage-collection cron.
 *
 * When wired up, this handler will:
 *
 *   1. SELECT v.id, v.manifest_object_key, c.object_key
 *      FROM backup_versions v
 *      LEFT JOIN backup_chunks c ON c.version_id = v.id
 *      WHERE v.deleted_at < now() - interval '7 days'
 *
 *   2. For each (manifest_object_key, chunk object_keys) tuple, issue
 *      DeleteObject calls against R2.
 *
 *   3. After successful R2 deletes, hard-delete the rows via
 *      DELETE FROM backup_versions WHERE id IN (...).
 *
 *   4. Separately, scan audit_log_account_deletions rows whose r2 prefix
 *      has not been purged, and delete the user's prefix.
 *
 * Schedule wiring (Vercel cron, qstash, GitHub Actions, etc.) is configured
 * in a separate change; this endpoint exists only so the route is reserved.
 */
export async function GET() {
  return withApiVersion(
    NextResponse.json({
      ok: true,
      todo: 'cron schedule wiring deferred to a follow-up change',
    }),
  );
}
