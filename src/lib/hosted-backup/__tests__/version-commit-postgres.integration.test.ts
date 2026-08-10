/**
 * Real-Postgres coverage for the two-phase version commit (contract §7, §8)
 * and the lifecycle honesty work in §10.
 *
 * These assertions are about SQL, so they run against SQL: migrations 0001 →
 * 0040 are applied into an isolated schema and `db.ts` is pointed at that
 * schema through the `__setHostedBackupSqlForTests` seam. The functions under
 * test are the real exported ones — no mock stands in for the predicate being
 * verified.
 *
 * Skipped when `EXOMEM_TEST_DATABASE_URL` is unset, matching the other
 * `*.integration.test.ts` suites in this repo.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  CANCELLED_RETENTION_DAYS,
  GRACE_WINDOW_DAYS,
  __setHostedBackupSqlForTests,
  commitVersion,
  enableStrictGenerationVisibility,
  expireCancelledSubscriptions,
  findVersionByOperationOwned,
  findVersionOperationOwned,
  findLegacyUnverifiedVersions,
  findStaleUncommittedVersions,
  getSubscriptionEntitlement,
  getSubscriptionStatus,
  getUserBackupStats,
  getVersionOwned,
  hardDeleteVersion,
  insertVersionWithChunks,
  finalizeReplayFenceOwned,
  leaseVersionForReplayOwned,
  listBackupsForUser,
  listVersions,
  markLegacyVerificationFailed,
  publishVerifiedLegacyVersion,
  softDeleteVersionsBeyondRetention,
  sumActiveStorageForUser,
  type HostedBackupSql,
} from "../db";
import { ensureExomemPostgresTestExtensions } from "../../exomem-hosted/__tests__/postgres-test-extensions";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const SCHEMA = "hosted_backup_version_commit";

// Everything backup_versions transitively needs, in application order. 0040 is
// applied separately by the backfill test so it can seed a pre-migration row.
const PRE_COMMIT_MIGRATIONS = [
  "0001_users.sql",
  "0005_backups.sql",
  "0006_backup_versions.sql",
  "0007_backup_chunks.sql",
  "0008_subscriptions.sql",
  "0012_subscriptions_plan.sql",
  "0013_subscriptions_status_paused.sql",
  "0016_gc_and_rate_limits.sql",
  "0024_subscription_scheduled_cancellation.sql",
];
const COMMIT_MIGRATION = "0040_backup_version_commit.sql";
const LIFECYCLE_COMPLETION_MIGRATION = "0041_endstate_cloud_lifecycle_completion.sql";
const OUTBOX_RELIABILITY_MIGRATION = "0042_supporter_outbox_reliability.sql";
const OPERATION_REPLAY_MIGRATION = "0043_backup_version_operation_replay.sql";

const USER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
const OTHER_USER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2";

let pool: Pool | undefined;

function taggedSql(client: Pool | PoolClient): HostedBackupSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function applyMigrationFile(file: string): Promise<void> {
  await pool!.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
}

function scopedUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
  return url.toString();
}

async function seedUsers(): Promise<void> {
  await pool!.query("INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)", [
    USER,
    "owner@example.com",
    OTHER_USER,
    "other@example.com",
  ]);
}

async function newBackup(userId: string, name: string): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    "INSERT INTO backups (user_id, name) VALUES ($1, $2) RETURNING id",
    [userId, name]
  );
  return rows[0].id;
}

let versionSeq = 0;
function nextVersionId(): string {
  versionSeq += 1;
  return `bbbbbbbb-2222-4222-8222-${String(versionSeq).padStart(12, "0")}`;
}

async function addVersion(opts: {
  backupId: string;
  sizeBytes: number;
  requiresCommit: boolean;
  clientCommitRequired?: boolean;
  createdAt?: string;
  userId?: string;
}): Promise<string> {
  const versionId = nextVersionId();
  const userId = opts.userId ?? USER;
  await insertVersionWithChunks({
    userId,
    quotaBytes: 1024 * 1024 * 1024,
    versionId,
    backupId: opts.backupId,
    sizeBytes: opts.sizeBytes,
    manifestSizeBytes: 0,
    manifestObjectKey: `users/${userId}/backups/${opts.backupId}/versions/${versionId}/manifest`,
    manifestSha256: new Uint8Array(32),
    chunkCount: 1,
    requiresCommit: opts.requiresCommit,
    clientCommitRequired: opts.clientCommitRequired,
    clientOperationId: `operation-${versionId}`,
    chunks: [
      {
        index: 0,
        objectKey: `users/${userId}/backups/${opts.backupId}/versions/${versionId}/chunks/0`,
        sizeBytes: opts.sizeBytes,
        sha256: new Uint8Array(32),
      },
    ],
    operationChunkMetadata: [{ index: 0, encryptedSize: opts.sizeBytes, sha256: "00".repeat(32) }],
  });
  if (opts.createdAt) {
    await pool!.query("UPDATE backup_versions SET created_at = $1 WHERE id = $2", [
      opts.createdAt,
      versionId,
    ]);
  }
  return versionId;
}

describe("hosted-backup version commit (Postgres)", { skip: !DATABASE_URL }, () => {
  before(async () => {
    await ensureExomemPostgresTestExtensions(DATABASE_URL!);
    const admin = new Pool({ connectionString: DATABASE_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    } finally {
      await admin.end();
    }
    pool = new Pool({ connectionString: scopedUrl(DATABASE_URL!) });
    for (const file of PRE_COMMIT_MIGRATIONS) await applyMigrationFile(file);
    __setHostedBackupSqlForTests(taggedSql(pool));
    await seedUsers();
  });

  after(async () => {
    __setHostedBackupSqlForTests(null);
    await pool?.end();
    const admin = new Pool({ connectionString: DATABASE_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("bridge-displays pre-cutoff history until strict visibility is enabled", async () => {
    // Seeded BEFORE 0040 exists — this is a genuine pre-migration row, the
    // shape every current subscriber's backup history is in today.
    const backupId = await newBackup(USER, "legacy");
    const { rows: seeded } = await pool!.query<{ id: string }>(
      `INSERT INTO backup_versions
         (backup_id, size_bytes, manifest_object_key, manifest_sha256, chunk_count)
       VALUES ($1, 4096, 'legacy/manifest', '\\x00'::bytea, 1)
       RETURNING id`,
      [backupId]
    );
    const legacyVersionId = seeded[0].id;

    await applyMigrationFile(COMMIT_MIGRATION);

    const { rows } = await pool!.query<{
      committed_at: Date | null;
      requires_commit: boolean;
      legacy_unverified: boolean;
    }>(
      "SELECT committed_at, requires_commit, legacy_unverified FROM backup_versions WHERE id = $1",
      [legacyVersionId]
    );
    assert.equal(rows[0].requires_commit, false, "existing rows must not be gated on a commit");
    assert.equal(rows[0].committed_at, null, "metadata alone is not proof of R2 durability");
    assert.equal(rows[0].legacy_unverified, true);

    const { rows: preLedger } = await pool!.query<{ id: string }>(
      `INSERT INTO backup_versions
         (backup_id, size_bytes, manifest_size_bytes, manifest_object_key, manifest_sha256,
          chunk_count, client_operation_id)
       VALUES ($1, 32, 0, 'pre-ledger/manifest', '\\x00'::bytea, 0, 'pre-ledger-operation')
       RETURNING id`,
      [backupId]
    );
    await applyMigrationFile(OPERATION_REPLAY_MIGRATION);
    await applyMigrationFile(OPERATION_REPLAY_MIGRATION);
    const populated = await findVersionOperationOwned({
      userId: USER,
      backupId,
      operationId: "pre-ledger-operation",
    });
    assert.equal(
      populated?.version_id,
      preLedger[0].id,
      "the forward migration backfills operations"
    );

    const visible = await listVersions(backupId);
    assert.deepEqual(
      visible.map((v) => v.id),
      [legacyVersionId],
      "Release A keeps pre-cutoff history available while the bounded verifier drains"
    );
    assert.equal(await sumActiveStorageForUser(USER), 4096);
    assert.equal((await getUserBackupStats(USER)).versionCount, 1);
    assert.equal(
      (await getVersionOwned({ userId: USER, backupId, versionId: legacyVersionId }))?.id,
      legacyVersionId,
      "download URL resolution observes the same Release-A bridge"
    );
    const summary = (await listBackupsForUser(USER)).find((backup) => backup.id === backupId)!;
    assert.equal(summary.version_count, 1, "summary observes the same Release-A bridge");

    const cutover = await enableStrictGenerationVisibility();
    assert.equal(cutover, "blocked_pending_legacy");
    assert.deepEqual(
      (await listVersions(backupId)).map((v) => v.id),
      [legacyVersionId],
      "a guarded cutover must not hide history while any pre-cutoff row remains pending"
    );
  });

  it("rejects an old application insert during the Release-A build window", async () => {
    const backupId = await newBackup(USER, "old-app-after-deploy");
    await assert.rejects(
      pool!.query(
        `INSERT INTO backup_versions
         (backup_id, size_bytes, manifest_size_bytes, manifest_object_key, manifest_sha256, chunk_count)
       VALUES ($1, 4096, 0, 'old-app/manifest', '\\x00'::bytea, 0)`,
        [backupId]
      ),
      /Release-A generation writes require a server operation identity/,
      "the pre-0040 binary cannot write an unbridged generation during a deployment"
    );
  });

  it("lets later valid legacy rows progress past a poisoned verification", async () => {
    const backupId = await newBackup(USER, "legacy-poison-progress");
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO backup_versions
         (backup_id, size_bytes, manifest_size_bytes, manifest_object_key, manifest_sha256, chunk_count,
          legacy_unverified, created_at, client_operation_id)
       VALUES
         ($1, 1, 0, 'poison/manifest', '\\x00'::bytea, 0, true, '2000-01-01T00:00:00Z', 'poison'),
         ($1, 1, 0, 'valid/manifest', '\\x00'::bytea, 0, true, '2001-01-01T00:00:00Z', 'valid')
       RETURNING id`,
      [backupId]
    );
    await markLegacyVerificationFailed(rows[0].id, "R2 object missing");
    const next = await findLegacyUnverifiedVersions(1);
    assert.equal(
      next[0].id,
      rows[1].id,
      "attempt count moves a poisoned row behind an unchecked generation"
    );
  });

  it("fences legacy publication while the stale-reclaim worker owns the row", async () => {
    const backupId = await newBackup(USER, "legacy-reclaim-fence");
    const versionId = await addVersion({
      backupId,
      sizeBytes: 1,
      requiresCommit: true,
      clientCommitRequired: true,
    });
    await pool!.query(
      "UPDATE backup_versions SET created_at = now() - interval '7 hours', legacy_unverified = true WHERE id = $1",
      [versionId]
    );

    const claimed = await findStaleUncommittedVersions({ olderThanHours: 6, limit: 1 });
    assert.equal(claimed[0]?.id, versionId);
    const replay = await findVersionByOperationOwned({
      userId: USER,
      backupId,
      operationId: `operation-${versionId}`,
    });
    assert.equal(replay?.gc_reclaim_token, claimed[0].gc_reclaim_token);
    assert.deepEqual(
      await findLegacyUnverifiedVersions(10),
      [],
      "reconciliation must not select a GC-owned version"
    );
    assert.equal(
      await publishVerifiedLegacyVersion(versionId),
      false,
      "publication must CAS on the absence of the reclaim lease"
    );
  });

  it("marks a reconciled legacy operation terminal for a later replay", async () => {
    const backupId = await newBackup(USER, "legacy-operation-terminal");
    const versionId = await addVersion({
      backupId,
      sizeBytes: 1,
      requiresCommit: true,
      clientCommitRequired: false,
    });

    assert.equal(await publishVerifiedLegacyVersion(versionId), true);
    const operation = await findVersionOperationOwned({
      userId: USER,
      backupId,
      operationId: `operation-${versionId}`,
    });
    assert.equal(operation?.version_id, versionId);
    assert.ok(
      operation?.committed_at,
      "reconciliation commits the durable operation ledger in the same statement"
    );
  });

  it("holds a replay lease across the presigned URL lifetime so GC cannot reclaim it", async () => {
    const backupId = await newBackup(USER, "replay-lease");
    const versionId = await addVersion({
      backupId,
      sizeBytes: 1,
      requiresCommit: true,
      clientCommitRequired: true,
      createdAt: "2020-01-01T00:00:00Z",
    });

    const leased = await leaseVersionForReplayOwned({
      userId: USER,
      backupId,
      operationId: `operation-${versionId}`,
      ttlSeconds: 300,
    });
    assert.equal(leased?.id, versionId);

    const stale = await findStaleUncommittedVersions({ olderThanHours: 6, limit: 50 });
    assert.ok(
      !stale.some((version) => version.id === versionId),
      "GC cannot claim a version after replay has reserved its URL-validity window"
    );
    const { rows } = await pool!.query<{ replay_fence_expires_at: Date }>(
      "SELECT replay_fence_expires_at FROM backup_versions WHERE id = $1",
      [versionId]
    );
    assert.ok(rows[0].replay_fence_expires_at.getTime() > Date.now());
  });

  it("finalises a replay fence after delayed signing before GC can reclaim it", async () => {
    const backupId = await newBackup(USER, "replay-fence-finalisation");
    const versionId = await addVersion({
      backupId,
      sizeBytes: 1,
      requiresCommit: true,
      clientCommitRequired: true,
      createdAt: "2020-01-01T00:00:00Z",
    });
    const leased = await leaseVersionForReplayOwned({
      userId: USER,
      backupId,
      operationId: `operation-${versionId}`,
      ttlSeconds: 1,
    });
    assert.ok(leased?.replay_fence_token);

    await pool!.query(
      "UPDATE backup_versions SET replay_fence_expires_at = now() - interval '1 second' WHERE id = $1",
      [versionId]
    );
    const { rows: provisionalFence } = await pool!.query<{ expired: boolean }>(
      "SELECT replay_fence_expires_at <= now() AS expired FROM backup_versions WHERE id = $1",
      [versionId]
    );
    assert.equal(
      provisionalFence[0].expired,
      true,
      "the provisional lease can elapse while a slow signer is minting URLs"
    );

    assert.equal(
      await finalizeReplayFenceOwned({
        userId: USER,
        backupId,
        versionId,
        replayFenceToken: leased!.replay_fence_token!,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      }),
      true
    );
    assert.ok(
      !(await findStaleUncommittedVersions({ olderThanHours: 6, limit: 50 })).some(
        (version) => version.id === versionId
      ),
      "the token-CAS finalisation prevents GC after all delayed URLs are signed"
    );
  });

  it("retains a committed operation tombstone after retention soft- and hard-delete", async () => {
    const backupId = await newBackup(USER, "operation-tombstone");
    const versionId = await addVersion({ backupId, sizeBytes: 10, requiresCommit: true });
    const committed = await commitVersion({ userId: USER, backupId, versionId });
    assert.ok(committed);

    assert.equal(await softDeleteVersionsBeyondRetention({ backupId, retain: 0 }), 1);
    assert.equal(await hardDeleteVersion(versionId), 1);

    const replay = await findVersionOperationOwned({
      userId: USER,
      backupId,
      operationId: `operation-${versionId}`,
    });
    assert.equal(replay?.version_id, versionId);
    assert.equal(
      new Date(replay?.committed_at ?? 0).toISOString(),
      new Date(committed.committedAt).toISOString()
    );
    assert.deepEqual(replay?.chunk_metadata, [
      { index: 0, encryptedSize: 10, sha256: "00".repeat(32) },
    ]);
  });

  it("cascades operation rows when an old binary hard-deletes a backup", async () => {
    const backupId = await newBackup(USER, "operation-backup-cascade");
    const versionId = await addVersion({ backupId, sizeBytes: 10, requiresCommit: true });

    await pool!.query("DELETE FROM backups WHERE id = $1", [backupId]);
    const { rows } = await pool!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM backup_version_operations WHERE version_id = $1",
      [versionId]
    );
    assert.equal(rows[0].count, "0");
  });

  it("cascades operation rows when an account is deleted", async () => {
    const deletedUser = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa3";
    await pool!.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      deletedUser,
      "delete-me@example.com",
    ]);
    const backupId = await newBackup(deletedUser, "operation-account-cascade");
    const versionId = await addVersion({
      userId: deletedUser,
      backupId,
      sizeBytes: 10,
      requiresCommit: true,
    });

    await pool!.query("DELETE FROM users WHERE id = $1", [deletedUser]);
    const { rows } = await pool!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM backup_version_operations WHERE version_id = $1",
      [versionId]
    );
    assert.equal(rows[0].count, "0");
  });

  it("enables strict visibility only after the pre-cutoff queue is drained", async () => {
    await pool!.query(`
      UPDATE backup_versions v
      SET legacy_unverified = false, committed_at = now()
      FROM hosted_backup_generation_visibility_policy p
      WHERE p.singleton = true
        AND v.legacy_unverified = true
        AND v.created_at < p.legacy_cutoff
    `);
    assert.equal(await enableStrictGenerationVisibility(), "enabled");
    assert.equal(await enableStrictGenerationVisibility(), "already_strict");
  });

  it("hides an uncommitted version from list, quota, stats and the backup summary", async () => {
    const backupId = await newBackup(USER, "gated");
    const before = await sumActiveStorageForUser(USER);

    const versionId = await addVersion({ backupId, sizeBytes: 1000, requiresCommit: true });

    assert.deepEqual(await listVersions(backupId), [], "uncommitted version must not be listed");
    assert.equal(
      await sumActiveStorageForUser(USER),
      before,
      "uncommitted bytes must not count against quota"
    );

    const summary = (await listBackupsForUser(USER)).find((b) => b.id === backupId)!;
    assert.equal(summary.latest_version_id, null);
    assert.equal(Number(summary.version_count), 0);
    assert.equal(Number(summary.total_size), 0);

    const stats = await getUserBackupStats(USER);
    assert.equal(stats.usedBytes, before);

    // …and becomes visible the moment it is committed.
    const committed = await commitVersion({ userId: USER, backupId, versionId });
    assert.ok(committed);
    assert.equal(committed.alreadyCommitted, false);

    assert.deepEqual(
      (await listVersions(backupId)).map((v) => v.id),
      [versionId]
    );
    assert.equal(await sumActiveStorageForUser(USER), before + 1000);
    const after = (await listBackupsForUser(USER)).find((b) => b.id === backupId)!;
    assert.equal(after.latest_version_id, versionId);
    assert.equal(Number(after.version_count), 1);
    assert.equal(Number(after.total_size), 1000);
  });

  it("keeps a post-cutoff schema-2.0 client's version pending for reconciliation", async () => {
    const backupId = await newBackup(USER, "legacy-client");
    const before = await sumActiveStorageForUser(USER);
    await addVersion({
      backupId,
      sizeBytes: 2000,
      requiresCommit: false,
      clientCommitRequired: false,
    });

    assert.deepEqual(
      (await listVersions(backupId)).map((v) => v.id),
      [],
      "post-cutoff legacy clients must not receive bridge visibility"
    );
    assert.equal(await sumActiveStorageForUser(USER), before);
    const summary = (await listBackupsForUser(USER)).find((b) => b.id === backupId)!;
    assert.equal(summary.latest_version_id, null);
    assert.equal(Number(summary.version_count), 0);
  });

  it("commit is idempotent and does not slide the commit timestamp forward", async () => {
    const backupId = await newBackup(USER, "idempotent");
    const versionId = await addVersion({ backupId, sizeBytes: 10, requiresCommit: true });

    const first = await commitVersion({ userId: USER, backupId, versionId });
    assert.ok(first);
    assert.equal(first.alreadyCommitted, false);

    const second = await commitVersion({ userId: USER, backupId, versionId });
    assert.ok(second);
    assert.equal(second.alreadyCommitted, true);
    assert.equal(
      new Date(second.committedAt).toISOString(),
      new Date(first.committedAt).toISOString(),
      "a replay returns the original commit time"
    );
  });

  it("commit is ownership-scoped — another user's version is simply not found", async () => {
    const backupId = await newBackup(USER, "owned");
    const versionId = await addVersion({ backupId, sizeBytes: 10, requiresCommit: true });

    assert.equal(
      await commitVersion({ userId: OTHER_USER, backupId, versionId }),
      null,
      "cross-user commit resolves to nothing (404 at the route)"
    );
    assert.equal(
      await commitVersion({ userId: USER, backupId, versionId: nextVersionId() }),
      null,
      "unknown version resolves to nothing"
    );

    // The real owner is unaffected by the failed attempts.
    const mine = await commitVersion({ userId: USER, backupId, versionId });
    assert.ok(mine);
    assert.equal(mine.alreadyCommitted, false);
  });

  it("retention never counts or evicts an uncommitted version", async () => {
    const backupId = await newBackup(USER, "retention");
    // Six committed versions, oldest first.
    const committed: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = await addVersion({
        backupId,
        sizeBytes: 100,
        requiresCommit: true,
        createdAt: `2026-01-0${i + 1}T00:00:00Z`,
      });
      await commitVersion({ userId: USER, backupId, versionId: id });
      committed.push(id);
    }
    // …plus a seventh push that died before commit.
    const abandoned = await addVersion({
      backupId,
      sizeBytes: 100,
      requiresCommit: true,
      createdAt: "2026-01-07T00:00:00Z",
    });

    const pruned = await softDeleteVersionsBeyondRetention({ backupId, retain: 5 });
    assert.equal(pruned, 1, "exactly the sixth-newest visible version is pruned");

    const remaining = (await listVersions(backupId)).map((v) => v.id);
    assert.equal(remaining.length, 5);
    assert.ok(!remaining.includes(committed[0]), "the oldest committed version is the one evicted");
    assert.ok(
      remaining.includes(committed[5]),
      "the newest committed version survives — the abandoned push did not take its slot"
    );

    const { rows } = await pool!.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM backup_versions WHERE id = $1",
      [abandoned]
    );
    assert.equal(
      rows[0].deleted_at,
      null,
      "retention leaves the uncommitted row alone — backup-gc reclaims it instead"
    );
  });

  it("a failed push evicts nothing: no commit, no prune", async () => {
    const backupId = await newBackup(USER, "failed-push");
    const good: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await addVersion({
        backupId,
        sizeBytes: 100,
        requiresCommit: true,
        createdAt: `2026-02-0${i + 1}T00:00:00Z`,
      });
      await commitVersion({ userId: USER, backupId, versionId: id });
      good.push(id);
    }
    // A sixth push that never commits. This is the regression: previously the
    // create call pruned retention immediately, so this failure alone deleted
    // `good[0]` — a version whose bytes were safely in R2.
    await addVersion({
      backupId,
      sizeBytes: 100,
      requiresCommit: true,
      createdAt: "2026-02-06T00:00:00Z",
    });

    const visible = (await listVersions(backupId)).map((v) => v.id);
    assert.deepEqual(
      [...visible].sort(),
      [...good].sort(),
      "all five good versions survive an abandoned push"
    );
  });

  it("finds stale uncommitted versions past the reclaim window, and nothing else", async () => {
    const backupId = await newBackup(USER, "stale");
    const stale = await addVersion({
      backupId,
      sizeBytes: 10,
      requiresCommit: true,
      createdAt: "2020-01-01T00:00:00Z",
    });
    const fresh = await addVersion({ backupId, sizeBytes: 10, requiresCommit: true });
    const oldButCommitted = await addVersion({
      backupId,
      sizeBytes: 10,
      requiresCommit: true,
      createdAt: "2020-01-01T00:00:00Z",
    });
    await commitVersion({ userId: USER, backupId, versionId: oldButCommitted });
    const oldLegacy = await addVersion({
      backupId,
      sizeBytes: 10,
      requiresCommit: false,
      createdAt: "2020-01-01T00:00:00Z",
    });

    const found = (await findStaleUncommittedVersions({ olderThanHours: 6, limit: 50 })).map(
      (v) => v.id
    );
    assert.ok(found.includes(stale), "an old uncommitted version is reclaimable");
    assert.ok(!found.includes(fresh), "a fresh push is still within its window");
    assert.ok(!found.includes(oldButCommitted), "a committed version is never reclaimed");
    assert.ok(
      !found.includes(oldLegacy),
      "a schema-2.0 version is never reclaimed — it owes no commit"
    );
  });
});

describe("hosted-backup subscription lifecycle (Postgres)", { skip: !DATABASE_URL }, () => {
  const LIFECYCLE_SCHEMA = "hosted_backup_lifecycle";
  let lifecyclePool: Pool | undefined;

  async function apply(file: string): Promise<void> {
    await lifecyclePool!.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
  }

  async function makeUser(email: string): Promise<string> {
    const { rows } = await lifecyclePool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [email]
    );
    return rows[0].id;
  }

  before(async () => {
    await ensureExomemPostgresTestExtensions(DATABASE_URL!);
    const admin = new Pool({ connectionString: DATABASE_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${LIFECYCLE_SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${LIFECYCLE_SCHEMA}`);
    } finally {
      await admin.end();
    }
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${LIFECYCLE_SCHEMA},public`);
    lifecyclePool = new Pool({ connectionString: url.toString() });
    for (const file of [
      ...PRE_COMMIT_MIGRATIONS,
      COMMIT_MIGRATION,
      LIFECYCLE_COMPLETION_MIGRATION,
      OUTBOX_RELIABILITY_MIGRATION,
      OPERATION_REPLAY_MIGRATION,
    ])
      await apply(file);
    __setHostedBackupSqlForTests(taggedSql(lifecyclePool));
  });

  after(async () => {
    __setHostedBackupSqlForTests(null);
    await lifecyclePool?.end();
    const admin = new Pool({ connectionString: DATABASE_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${LIFECYCLE_SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("grace lasts 30 days, matching the contract and the public Terms", async () => {
    assert.equal(GRACE_WINDOW_DAYS, 30);
    const userId = await makeUser("grace@example.com");
    await lifecyclePool!.query(
      `INSERT INTO subscriptions (user_id, status, grace_started_at)
       VALUES ($1, 'grace', now() - interval '20 days')`,
      [userId]
    );
    assert.equal(
      await getSubscriptionStatus(userId),
      "grace",
      "day 20 of grace is still grace — the old 14-day constant cut this user off"
    );

    await lifecyclePool!.query(
      "UPDATE subscriptions SET grace_started_at = now() - interval '31 days' WHERE user_id = $1",
      [userId]
    );
    assert.equal(await getSubscriptionStatus(userId), "cancelled", "past 30 days, grace ends");

    const entitlement = await getSubscriptionEntitlement(userId);
    assert.equal(entitlement.effectiveStatus, "cancelled");
    assert.equal(entitlement.storedStatus, "grace");
  });

  it("cancelled falls to none once the 30-day retention window closes", async () => {
    assert.equal(CANCELLED_RETENTION_DAYS, 30);
    const userId = await makeUser("cancelled@example.com");
    await lifecyclePool!.query(
      `INSERT INTO subscriptions (user_id, status, cancel_started_at)
       VALUES ($1, 'cancelled', now() - interval '10 days')`,
      [userId]
    );
    assert.equal(
      await getSubscriptionStatus(userId),
      "cancelled",
      "inside the window the user can still read and reactivate"
    );

    await lifecyclePool!.query(
      "UPDATE subscriptions SET cancel_started_at = now() - interval '31 days' WHERE user_id = $1",
      [userId]
    );
    assert.equal(await getSubscriptionStatus(userId), "none", "past the window, access is gone");
    assert.equal((await getSubscriptionEntitlement(userId)).effectiveStatus, "none");
  });

  it("persists a missed final Paddle cancellation at the deterministic grace deadline", async () => {
    await lifecyclePool!.query("DELETE FROM subscriptions");
    const userId = await makeUser("missed-cancel@example.com");
    await lifecyclePool!.query(
      `INSERT INTO subscriptions (user_id, status, grace_started_at)
       VALUES ($1, 'grace', now() - interval '31 days')`,
      [userId]
    );

    const result = await expireCancelledSubscriptions({ limit: 25 });
    assert.equal(result.graceExpired, 1);
    const { rows } = await lifecyclePool!.query<{
      status: string;
      cancel_started_at: Date;
      grace_started_at: Date;
    }>("SELECT status, cancel_started_at, grace_started_at FROM subscriptions WHERE user_id = $1", [
      userId,
    ]);
    assert.equal(rows[0].status, "cancelled");
    assert.equal(
      rows[0].cancel_started_at.getTime() - rows[0].grace_started_at.getTime(),
      30 * 24 * 60 * 60 * 1000,
      "retention begins at the grace deadline, not whenever cron happened to run"
    );
  });

  it("does not expire data when Paddle reactivates before grace expiry", async () => {
    await lifecyclePool!.query("DELETE FROM subscriptions");
    const userId = await makeUser("resubscribed@example.com");
    await lifecyclePool!.query(
      `INSERT INTO subscriptions (user_id, status, grace_started_at)
       VALUES ($1, 'active', now() - interval '31 days')`,
      [userId]
    );

    const result = await expireCancelledSubscriptions({ limit: 25 });
    assert.equal(result.graceExpired, 0);
    const { rows } = await lifecyclePool!.query<{ status: string }>(
      "SELECT status FROM subscriptions WHERE user_id = $1",
      [userId]
    );
    assert.equal(rows[0].status, "active");
  });

  it("purges expired cancellations: data deleted, prefix enqueued, status downgraded", async () => {
    // Own the whole subscriptions table for this case — the read-time cutoff
    // cases above leave rows that would otherwise be swept up here.
    await lifecyclePool!.query("DELETE FROM subscriptions");
    const expiredUser = await makeUser("expired@example.com");
    const freshUser = await makeUser("fresh@example.com");
    await lifecyclePool!.query(
      `INSERT INTO subscriptions (user_id, status, cancel_started_at) VALUES
         ($1, 'cancelled', now() - interval '45 days'),
         ($2, 'cancelled', now() - interval '5 days')`,
      [expiredUser, freshUser]
    );
    const { rows: expiredBackups } = await lifecyclePool!.query<{ id: string }>(
      "INSERT INTO backups (user_id, name) VALUES ($1, 'gone') RETURNING id",
      [expiredUser]
    );
    await lifecyclePool!.query("INSERT INTO backups (user_id, name) VALUES ($1, 'still here')", [
      freshUser,
    ]);
    await lifecyclePool!.query(
      `INSERT INTO backup_versions
         (backup_id, size_bytes, manifest_size_bytes, manifest_object_key, manifest_sha256,
          chunk_count, client_operation_id)
       VALUES ($1, 512, 0, 'm', '\\x00'::bytea, 1, 'lifecycle-expired-version')`,
      [expiredBackups[0].id]
    );

    const result = await expireCancelledSubscriptions({ limit: 25 });
    assert.equal(result.downgraded, 1, "only the expired subscriber is downgraded");
    assert.equal(result.prefixesEnqueued, 1);

    const { rows: statuses } = await lifecyclePool!.query<{ user_id: string; status: string }>(
      "SELECT user_id, status FROM subscriptions WHERE user_id = ANY($1::uuid[])",
      [[expiredUser, freshUser]]
    );
    const byUser = new Map(statuses.map((r) => [r.user_id, r.status]));
    assert.equal(byUser.get(expiredUser), "none");
    assert.equal(byUser.get(freshUser), "cancelled");

    const { rows: remaining } = await lifecyclePool!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM backups WHERE user_id = $1",
      [expiredUser]
    );
    assert.equal(remaining[0].count, "0", "the expired subscriber's backups are gone");
    const { rows: versions } = await lifecyclePool!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM backup_versions"
    );
    assert.equal(versions[0].count, "0", "versions cascade with their backup");

    const { rows: queued } = await lifecyclePool!.query<{ r2_prefix: string }>(
      "SELECT r2_prefix FROM r2_purge_queue WHERE purged_at IS NULL"
    );
    assert.deepEqual(
      queued.map((r) => r.r2_prefix),
      [`users/${expiredUser}/backups/${expiredBackups[0].id}/`],
      "only the immutable old backup prefix is queued, never a mutable account-wide prefix"
    );

    // The account itself survives — §10 promises the user can re-subscribe.
    const { rows: userRows } = await lifecyclePool!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM users WHERE id = $1",
      [expiredUser]
    );
    assert.equal(userRows[0].count, "1");

    // Idempotent: the downgrade removes the row from the candidate set.
    const second = await expireCancelledSubscriptions({ limit: 25 });
    assert.equal(second.downgraded, 0);
    assert.equal(second.prefixesEnqueued, 0);
  });
});
