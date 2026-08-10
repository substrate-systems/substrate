import { NextRequest, NextResponse } from "next/server";
import { withApiVersion } from "@/lib/hosted-backup/api-version";
import { verifyCronAuth } from "@/lib/hosted-backup/cron-auth";
import { captureCronOutcome } from "@/lib/analytics-server";
import {
  findExpiredDeletedVersions,
  listChunksForVersion,
  hardDeleteVersion,
  findPendingPurges,
  markPurgeDone,
  markPurgeAttemptFailed,
  findUncheckedManifestVersions,
  stampManifestSeen,
  softDeleteVersionById,
  findStaleUncommittedVersions,
  releaseStaleUncommittedReclaim,
  findLegacyUnverifiedVersions,
  markLegacyVerificationFailed,
  quarantineLegacyVersion,
  publishVerifiedLegacyVersion,
  softDeleteVersionsBeyondRetention,
  expireCancelledSubscriptions,
  deleteRateLimitEventsBefore,
} from "@/lib/hosted-backup/db";
import { HostedBackupError, errors } from "@/lib/hosted-backup/errors";
import {
  deleteObjects,
  headObject,
  headObjectExists,
  listObjectKeys,
} from "@/lib/hosted-backup/r2";
import { runAlertBacklogMaintenance } from "@/lib/exomem-hosted/alert-receiver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-run work caps. Daily cadence; a backlog larger than one run's budget
// drains across subsequent days. Every pass is idempotent and crash-safe:
// R2 objects are deleted BEFORE the DB rows that carry their keys, so a
// re-run after a mid-pass crash simply retries (deleting a missing R2 key
// is a no-op in S3 semantics).
const EXPIRED_VERSIONS_PER_RUN = 25;
const PURGE_PREFIXES_PER_RUN = 5;
const PURGE_PAGES_PER_PREFIX = 10;
// A prefix that fails this many runs is dead-lettered (stays in the table
// with last_error for inspection, no longer selected) so a poison prefix
// can't head-of-line-block the queue forever. ~1 month at daily cadence.
const PURGE_MAX_ATTEMPTS = 30;
const ABANDONED_CHECKS_PER_RUN = 50;
// Presigned PUT URLs live 5 minutes, so a manifest absent 48h after mint can
// never appear later — HEAD-404 at that age is a definitive abandon signal.
const ABANDONED_MIN_AGE_HOURS = 48;
const RATE_LIMIT_RETENTION_HOURS = 24;
// Uncommitted versions (schema >= 2.1 clients) are reclaimed on a MUCH
// shorter clock than the 48h manifest sweep above. A push has 5 minutes of
// presigned-URL life; a commit that has not arrived hours later is never
// arriving, and until it is reclaimed the abandoned upload holds quota the
// subscriber paid for. Deliberately generous enough to survive a slow
// large-backup upload over a poor connection, deliberately far short of 48h.
const UNCOMMITTED_RECLAIM_HOURS = 6;
const UNCOMMITTED_RECLAIMS_PER_RUN = 50;
// Historical rows are deliberately untrusted after migration. This remains
// bounded (and R2 HEAD concurrency remains four), but 250/run avoids leaving
// ordinary subscriber history unavailable for months on a daily cron.
const LEGACY_VERIFICATIONS_PER_RUN = 250;
const HEAD_CONCURRENCY = 4;
// Cancelled subscribers whose 30-day retention window has closed, per run.
const CANCELLED_EXPIRIES_PER_RUN = 25;

function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return withApiVersion(NextResponse.json(body, { status }));
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return ok({ success: false, error: { code: "UNAUTHENTICATED" } }, 401);
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
        const keys = [...chunks.map((c) => c.object_key), version.manifest_object_key];
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
    fail("pass A", err);
  }

  // Pass B — drain the hard-delete purge queue (backup + account deletes).
  let purgeQueueMarkedDone = 0;
  let purgeQueueObjectsDeleted = 0;
  try {
    const pending = await findPendingPurges({
      limit: PURGE_PREFIXES_PER_RUN,
      maxAttempts: PURGE_MAX_ATTEMPTS,
    });
    for (const row of pending) {
      try {
        // Always lists from the prefix root (no continuation token): this
        // works because every listed key is deleted before the next list, so
        // each iteration sees only what remains. A partial failure throws,
        // leaving the row pending for a clean restart next run.
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
        try {
          await markPurgeAttemptFailed({ id: row.id, error: String(err) });
        } catch (markErr) {
          fail(`pass B mark-attempt ${row.id}`, markErr);
        }
      }
    }
  } catch (err) {
    fail("pass B", err);
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
        if (state === "present") {
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
    fail("pass C", err);
  }

  // Pass F — reclaim stale uncommitted versions. A schema-2.1 client creates
  // a version invisible and publishes it with an explicit commit; a push that
  // dies in between leaves a row nobody can see, holding quota and R2 bytes.
  // Nothing ever showed it to the user, so there is no 7-day soft-delete
  // window to honour: the objects go and the row goes, in that order (same
  // R2-before-DB discipline as Pass A, for the same crash-safety reason).
  //
  // This is the pass that closes the manifest-present/chunks-missing hole
  // Pass C structurally cannot see: the client uploads the manifest FIRST, so
  // a HEAD on the manifest object says "present" for exactly the pushes that
  // failed partway through their chunks.
  let staleUncommittedReclaimed = 0;
  let staleUncommittedObjectsDeleted = 0;
  try {
    const stale = await findStaleUncommittedVersions({
      olderThanHours: UNCOMMITTED_RECLAIM_HOURS,
      limit: UNCOMMITTED_RECLAIMS_PER_RUN,
    });
    for (const version of stale) {
      try {
        const chunks = await listChunksForVersion(version.id);
        const keys = [...chunks.map((c) => c.object_key), version.manifest_object_key];
        staleUncommittedObjectsDeleted += await deleteObjects(keys);
        if (await hardDeleteVersion(version.id, version.gc_reclaim_token)) {
          staleUncommittedReclaimed += 1;
        }
      } catch (err) {
        await releaseStaleUncommittedReclaim(version.id, version.gc_reclaim_token).catch(
          () => undefined
        );
        fail(`pass F version ${version.id}`, err);
      }
    }
  } catch (err) {
    fail("pass F", err);
  }

  // Pass H — reconcile historical generations before exposing them. A legacy
  // row proves only that old metadata was written, not that every encrypted
  // object survived. HEAD proves exact presence and length; clients still
  // prove SHA-256 and AEAD integrity after download.
  let legacyVersionsVerified = 0;
  try {
    const legacy = await findLegacyUnverifiedVersions(LEGACY_VERIFICATIONS_PER_RUN);
    for (const version of legacy) {
      try {
        const chunks = await listChunksForVersion(version.id);
        const expected = [
          { key: version.manifest_object_key, size: Number(version.manifest_size_bytes) },
          ...chunks.map((chunk) => ({ key: chunk.object_key, size: Number(chunk.size_bytes) })),
        ];
        await verifyObjectLengths(expected);
        if (await publishVerifiedLegacyVersion(version.id)) {
          await softDeleteVersionsBeyondRetention({ backupId: version.backup_id, retain: 5 });
          legacyVersionsVerified += 1;
        }
      } catch (err) {
        if (err instanceof HostedBackupError && err.code === "UPLOAD_INCOMPLETE") {
          await quarantineLegacyVersion(version.id, String(err)).catch(() => undefined);
        } else {
          await markLegacyVerificationFailed(version.id, String(err)).catch(() => undefined);
        }
        fail(`pass H version ${version.id}`, err);
      }
    }
  } catch (err) {
    fail("pass H", err);
  }

  // Pass G — post-cancellation purge. Contract §10 and the public Terms both
  // promise that a cancelled subscriber's data is kept 30 days for
  // reactivation and then permanently deleted. `cancel_started_at` has been
  // written since the subscription state machine shipped; nothing read it and
  // no job ever ran, so the promise was not true. This pass makes it true:
  // backups (and their cascaded versions/chunks) are deleted, the R2 prefix is
  // enqueued into the existing purge queue that Pass B drains, and the stored
  // status drops to `none`. The account itself survives — §10 is explicit that
  // the user can come back and re-subscribe.
  let cancelledSubscriptionsExpired = 0;
  let graceSubscriptionsCancelled = 0;
  let cancelledPrefixesEnqueued = 0;
  try {
    const expired = await expireCancelledSubscriptions({
      limit: CANCELLED_EXPIRIES_PER_RUN,
    });
    graceSubscriptionsCancelled = expired.graceExpired;
    cancelledSubscriptionsExpired = expired.downgraded;
    cancelledPrefixesEnqueued = expired.prefixesEnqueued;
  } catch (err) {
    fail("pass G", err);
  }

  // Pass D — prune rate-limit events (windows in use are ≤ 1 hour).
  let rateLimitEventsPruned = 0;
  try {
    rateLimitEventsPruned = await deleteRateLimitEventsBefore(RATE_LIMIT_RETENTION_HOURS);
  } catch (err) {
    fail("pass D", err);
  }

  // Pass E: scheduler alert notification backlog.
  //
  // The alert receiver normally drains itself after each incoming transition,
  // but that only helps while transitions keep arriving. If mail delivery is
  // broken and the cluster goes quiet, an accepted alert could sit unsent with
  // nobody told. This pass is the K3s-independent backstop, so worst-case
  // detection latency is one day rather than unbounded.
  // Deliberately kept out of errorCount: that counter is about this job's own
  // GC passes, and an alert-delivery problem is not a backup-GC failure.
  const alerts = await runAlertBacklogMaintenance(20);

  // errorCount is the signal that matters: a pass can complete having failed
  // several sub-passes, and a silently degrading GC is worse than a loud one.
  // A parked alert needs a human, so it marks the outcome failed too.
  await captureCronOutcome({
    job: "backup-gc",
    outcome: errorCount > 0 || alerts.failed > 0 || alerts.errored ? "failed" : "completed",
    properties: {
      expiredVersionsPurged,
      expiredObjectsDeleted,
      purgeQueueMarkedDone,
      purgeQueueObjectsDeleted,
      manifestsStamped,
      abandonedSoftDeleted,
      staleUncommittedReclaimed,
      staleUncommittedObjectsDeleted,
      legacyVersionsVerified,
      cancelledSubscriptionsExpired,
      graceSubscriptionsCancelled,
      cancelledPrefixesEnqueued,
      rateLimitEventsPruned,
      alertsNotified: alerts.notified,
      alertBacklogPending: alerts.pending,
      alertBacklogFailed: alerts.failed,
      alertBacklogErrored: alerts.errored,
      errorCount,
    },
  });

  return ok({
    ok: true,
    expiredVersionsPurged,
    expiredObjectsDeleted,
    purgeQueueMarkedDone,
    purgeQueueObjectsDeleted,
    manifestsStamped,
    abandonedSoftDeleted,
    staleUncommittedReclaimed,
    staleUncommittedObjectsDeleted,
    legacyVersionsVerified,
    cancelledSubscriptionsExpired,
    graceSubscriptionsCancelled,
    cancelledPrefixesEnqueued,
    rateLimitEventsPruned,
    alertsNotified: alerts.notified,
    alertBacklogPending: alerts.pending,
    alertBacklogFailed: alerts.failed,
    alertBacklogErrored: alerts.errored,
    errorCount,
  });
}

async function verifyObjectLengths(expected: Array<{ key: string; size: number }>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < expected.length) {
      const item = expected[next++];
      const result = await headObject(item.key);
      if (result.state !== "present" || result.contentLength !== item.size) {
        throw errors.uploadIncomplete({
          object: item.key,
          expectedBytes: item.size,
          actualBytes: result.contentLength ?? null,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, expected.length) }, worker));
}
