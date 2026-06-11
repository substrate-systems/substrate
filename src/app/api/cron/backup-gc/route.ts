import { NextRequest, NextResponse } from 'next/server';
import { withApiVersion } from '@/lib/hosted-backup/api-version';
import { verifyCronAuth } from '@/lib/hosted-backup/cron-auth';
import {
  findExpiredDeletedVersions,
  listChunksForVersion,
  hardDeleteVersion,
  findPendingPurges,
  markPurgeDone,
  findUncheckedManifestVersions,
  stampManifestSeen,
  softDeleteVersionById,
  deleteRateLimitEventsBefore,
} from '@/lib/hosted-backup/db';
import {
  deleteObjects,
  headObjectExists,
  listObjectKeys,
} from '@/lib/hosted-backup/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-run work caps. Daily cadence; a backlog larger than one run's budget
// drains across subsequent days. Every pass is idempotent and crash-safe:
// R2 objects are deleted BEFORE the DB rows that carry their keys, so a
// re-run after a mid-pass crash simply retries (deleting a missing R2 key
// is a no-op in S3 semantics).
const EXPIRED_VERSIONS_PER_RUN = 25;
const PURGE_PREFIXES_PER_RUN = 5;
const PURGE_PAGES_PER_PREFIX = 10;
const ABANDONED_CHECKS_PER_RUN = 50;
// Presigned PUT URLs live 5 minutes, so a manifest absent 48h after mint can
// never appear later — HEAD-404 at that age is a definitive abandon signal.
const ABANDONED_MIN_AGE_HOURS = 48;
const RATE_LIMIT_RETENTION_HOURS = 24;

function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return withApiVersion(NextResponse.json(body, { status }));
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return ok({ success: false, error: { code: 'UNAUTHENTICATED' } }, 401);
  }

  let errorCount = 0;
  const fail = (where: string, err: unknown) => {
    errorCount += 1;
    console.error(`[hosted-backup cron/backup-gc] ${where}:`, err);
  };

  // Pass A — purge soft-deleted versions past the 7-day window.
  let expiredVersionsPurged = 0;
  let expiredObjectsDeleted = 0;
  try {
    const expired = await findExpiredDeletedVersions(EXPIRED_VERSIONS_PER_RUN);
    for (const version of expired) {
      try {
        const chunks = await listChunksForVersion(version.id);
        const keys = [
          ...chunks.map((c) => c.object_key),
          version.manifest_object_key,
        ];
        // R2 first, DB second: if the run dies between the two, the rows
        // survive and the next run retries the idempotent R2 deletes.
        expiredObjectsDeleted += await deleteObjects(keys);
        await hardDeleteVersion(version.id);
        expiredVersionsPurged += 1;
      } catch (err) {
        fail(`pass A version ${version.id}`, err);
      }
    }
  } catch (err) {
    fail('pass A', err);
  }

  // Pass B — drain the hard-delete purge queue (backup + account deletes).
  let purgeQueueMarkedDone = 0;
  let purgeQueueObjectsDeleted = 0;
  try {
    const pending = await findPendingPurges(PURGE_PREFIXES_PER_RUN);
    for (const row of pending) {
      try {
        for (let page = 0; page <= PURGE_PAGES_PER_PREFIX; page++) {
          const { keys } = await listObjectKeys(row.r2_prefix);
          if (keys.length === 0) {
            // Marked done only once the prefix lists empty; a partially
            // drained prefix stays pending for the next run.
            await markPurgeDone(row.id);
            purgeQueueMarkedDone += 1;
            break;
          }
          if (page === PURGE_PAGES_PER_PREFIX) break; // budget spent
          purgeQueueObjectsDeleted += await deleteObjects(keys);
        }
      } catch (err) {
        fail(`pass B prefix ${row.r2_prefix}`, err);
      }
    }
  } catch (err) {
    fail('pass B', err);
  }

  // Pass C — abandoned-upload sweep. Each version is HEAD-checked at most
  // once: 200 stamps manifest_seen_at (never re-checked), explicit 404
  // soft-deletes (Pass A purges it after the 7-day window), and a transport
  // error changes nothing.
  let manifestsStamped = 0;
  let abandonedSoftDeleted = 0;
  try {
    const candidates = await findUncheckedManifestVersions({
      olderThanHours: ABANDONED_MIN_AGE_HOURS,
      limit: ABANDONED_CHECKS_PER_RUN,
    });
    for (const candidate of candidates) {
      try {
        const state = await headObjectExists(candidate.manifest_object_key);
        if (state === 'present') {
          await stampManifestSeen(candidate.id);
          manifestsStamped += 1;
        } else {
          await softDeleteVersionById(candidate.id);
          abandonedSoftDeleted += 1;
        }
      } catch (err) {
        fail(`pass C version ${candidate.id}`, err);
      }
    }
  } catch (err) {
    fail('pass C', err);
  }

  // Pass D — prune rate-limit events (windows in use are ≤ 1 hour).
  let rateLimitEventsPruned = 0;
  try {
    rateLimitEventsPruned = await deleteRateLimitEventsBefore(
      RATE_LIMIT_RETENTION_HOURS,
    );
  } catch (err) {
    fail('pass D', err);
  }

  return ok({
    ok: true,
    expiredVersionsPurged,
    expiredObjectsDeleted,
    purgeQueueMarkedDone,
    purgeQueueObjectsDeleted,
    manifestsStamped,
    abandonedSoftDeleted,
    rateLimitEventsPruned,
    errorCount,
  });
}
