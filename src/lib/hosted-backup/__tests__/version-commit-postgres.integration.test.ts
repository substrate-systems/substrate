/**
 * Real-Postgres coverage for the two-phase version commit (contract §7, §8).
 *
 * These assertions are about SQL, so they run against SQL: migrations 0001 →
 * 0038 are applied into an isolated schema and `db.ts` is pointed at that
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
  __setHostedBackupSqlForTests,
  commitVersion,
  findStaleUncommittedVersions,
  getUserBackupStats,
  insertVersionWithChunks,
  listBackupsForUser,
  listVersions,
  softDeleteVersionsBeyondRetention,
  sumActiveStorageForUser,
  type HostedBackupSql,
} from "../db";
import { ensureExomemPostgresTestExtensions } from "../../exomem-hosted/__tests__/postgres-test-extensions";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const SCHEMA = "hosted_backup_version_commit";

// Everything backup_versions transitively needs, in application order. 0038 is
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
const COMMIT_MIGRATION = "0038_backup_version_commit.sql";

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

function statements(file: string): string[] {
  return readFileSync(resolve(process.cwd(), "migrations", file), "utf8")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment >= 0 ? line.slice(0, comment) : line;
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigrationFile(file: string): Promise<void> {
  for (const statement of statements(file)) await pool!.query(statement);
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
  createdAt?: string;
}): Promise<string> {
  const versionId = nextVersionId();
  await insertVersionWithChunks({
    versionId,
    backupId: opts.backupId,
    sizeBytes: opts.sizeBytes,
    manifestObjectKey: `users/${USER}/backups/${opts.backupId}/versions/${versionId}/manifest`,
    manifestSha256: new Uint8Array(32),
    chunkCount: 1,
    requiresCommit: opts.requiresCommit,
    chunks: [
      {
        index: 0,
        objectKey: `users/${USER}/backups/${opts.backupId}/versions/${versionId}/chunks/0`,
        sizeBytes: opts.sizeBytes,
        sha256: new Uint8Array(32),
      },
    ],
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

  it("backfills every pre-existing version as committed so no history disappears", async () => {
    // Seeded BEFORE 0038 exists — this is a genuine pre-migration row, the
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
      created_at: Date;
      requires_commit: boolean;
    }>("SELECT committed_at, created_at, requires_commit FROM backup_versions WHERE id = $1", [
      legacyVersionId,
    ]);
    assert.equal(rows[0].requires_commit, false, "existing rows must not be gated on a commit");
    assert.notEqual(rows[0].committed_at, null, "backfill must stamp committed_at");
    assert.equal(
      rows[0].committed_at!.toISOString(),
      rows[0].created_at.toISOString(),
      "backfilled commit time is the original creation time"
    );

    const visible = await listVersions(backupId);
    assert.deepEqual(
      visible.map((v) => v.id),
      [legacyVersionId],
      "a pre-existing version stays visible after the migration"
    );
    assert.equal(await sumActiveStorageForUser(USER), 4096);
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

  it("keeps a schema-2.0 client's version visible with no commit call", async () => {
    const backupId = await newBackup(USER, "legacy-client");
    const before = await sumActiveStorageForUser(USER);
    const versionId = await addVersion({ backupId, sizeBytes: 2000, requiresCommit: false });

    assert.deepEqual(
      (await listVersions(backupId)).map((v) => v.id),
      [versionId],
      "requires_commit = false must be visible immediately"
    );
    assert.equal(await sumActiveStorageForUser(USER), before + 2000);
    const summary = (await listBackupsForUser(USER)).find((b) => b.id === backupId)!;
    assert.equal(summary.latest_version_id, versionId);
    assert.equal(Number(summary.version_count), 1);
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
