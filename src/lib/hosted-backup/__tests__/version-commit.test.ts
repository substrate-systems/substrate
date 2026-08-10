/**
 * Storage-layer behaviour of the two-phase version commit (contract §7, §8),
 * plus the request-header schema negotiation that decides which phase model a
 * caller gets.
 *
 * The `../db` mock here is a small in-memory row store rather than a set of
 * assertion stubs: it records `requires_commit` / `committed_at` and applies
 * the same visibility rule the SQL does, so the code under test
 * (`createVersionWithUploads`, `commitVersionUpload`) runs for real against
 * realistic rows. The SQL those functions call is separately exercised
 * against a live Postgres in `version-commit-postgres.integration.test.ts`.
 *
 * Requires `--experimental-test-module-mocks` (set in the npm test script).
 */

import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.ENDSTATE_R2_ENDPOINT = "https://test-account.r2.cloudflarestorage.com";
process.env.ENDSTATE_R2_ACCESS_KEY_ID = "AKIATESTKEY1234567890";
process.env.ENDSTATE_R2_SECRET_ACCESS_KEY = "secret-test-key-very-long-string";
process.env.ENDSTATE_R2_BUCKET = "endstate-backups-test";

type VersionRow = {
  id: string;
  backup_id: string;
  created_at: string;
  size_bytes: number;
  manifest_size_bytes: number;
  manifest_object_key: string;
  manifest_sha256: Uint8Array;
  chunk_count: number;
  requires_commit: boolean;
  client_commit_required: boolean;
  client_operation_id: string | null;
  committed_at: string | null;
  gc_reclaim_token: string | null;
  replay_fence_token: string | null;
  replay_fence_expires_at: string | null;
  deleted_at: string | null;
};

type Store = {
  backups: Map<string, { id: string; user_id: string }>;
  versions: VersionRow[];
  pruneCalls: number;
  clock: number;
  operationLookups: number;
  forceInsertNull: boolean;
  putCalls: Array<{ key: string; options: unknown }>;
  nextPutExpiries: Date[];
  replayFenceFinalisations: Array<{ token: string; expiresAt: Date }>;
};

let store: Store;

function visible(v: VersionRow): boolean {
  return v.deleted_at === null && (v.requires_commit === false || v.committed_at !== null);
}

function setupMocks() {
  store = {
    backups: new Map(),
    versions: [],
    pruneCalls: 0,
    clock: 0,
    operationLookups: 0,
    forceInsertNull: false,
    putCalls: [],
    nextPutExpiries: [],
    replayFenceFinalisations: [],
  };

  mock.module("../db", {
    namedExports: {
      getBackupOwned: async (userId: string, backupId: string) => {
        const b = store.backups.get(backupId);
        return b && b.user_id === userId ? { ...b, deleted_at: null } : null;
      },
      sumActiveStorageForUser: async (userId: string) =>
        store.versions
          .filter((v) => visible(v) && store.backups.get(v.backup_id)?.user_id === userId)
          .reduce((acc, v) => acc + v.size_bytes, 0),
      insertVersionWithChunks: async (params: {
        versionId: string;
        backupId: string;
        sizeBytes: number;
        manifestSizeBytes: number;
        manifestObjectKey: string;
        manifestSha256: Uint8Array;
        chunkCount: number;
        requiresCommit?: boolean;
        clientCommitRequired?: boolean;
        clientOperationId?: string | null;
      }) => {
        if (store.forceInsertNull) return null;
        store.clock += 1;
        const row: VersionRow = {
          id: params.versionId,
          backup_id: params.backupId,
          created_at: new Date(store.clock * 1000).toISOString(),
          size_bytes: params.sizeBytes,
          manifest_size_bytes: params.manifestSizeBytes,
          manifest_object_key: params.manifestObjectKey,
          manifest_sha256: params.manifestSha256,
          chunk_count: params.chunkCount,
          requires_commit: params.requiresCommit ?? false,
          client_commit_required: params.clientCommitRequired ?? false,
          client_operation_id: params.clientOperationId ?? null,
          committed_at: null,
          gc_reclaim_token: null,
          replay_fence_token: null,
          replay_fence_expires_at: null,
          deleted_at: null,
        };
        store.versions.push(row);
        return row;
      },
      commitVersion: async (params: {
        userId: string;
        backupId: string;
        versionId: string;
        retain?: number;
      }) => {
        const row = store.versions.find(
          (v) =>
            v.id === params.versionId &&
            v.backup_id === params.backupId &&
            v.deleted_at === null &&
            store.backups.get(v.backup_id)?.user_id === params.userId
        );
        if (!row) return null;
        if (row.committed_at !== null) {
          return { committedAt: row.committed_at, alreadyCommitted: true, prunedVersions: 0 };
        }
        store.clock += 1;
        row.committed_at = new Date(store.clock * 1000).toISOString();
        store.pruneCalls += 1;
        const visibleRows = store.versions
          .filter((v) => v.backup_id === params.backupId && visible(v))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        let prunedVersions = 0;
        for (const candidate of visibleRows.slice(params.retain ?? 5)) {
          candidate.deleted_at = new Date().toISOString();
          prunedVersions += 1;
        }
        return { committedAt: row.committed_at, alreadyCommitted: false, prunedVersions };
      },
      softDeleteVersionsBeyondRetention: async (params: { backupId: string; retain: number }) => {
        store.pruneCalls += 1;
        const keep = new Set(
          store.versions
            .filter((v) => v.backup_id === params.backupId && visible(v))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .slice(0, params.retain)
            .map((v) => v.id)
        );
        let pruned = 0;
        for (const v of store.versions) {
          if (v.backup_id === params.backupId && visible(v) && !keep.has(v.id)) {
            v.deleted_at = new Date().toISOString();
            pruned += 1;
          }
        }
        return pruned;
      },
      // Unrelated exports imported by storage.ts.
      insertBackup: async () => ({}),
      listBackupsForUser: async () => [],
      deleteBackupOwned: async () => 1,
      updateBackupOwned: async () => null,
      listVersions: async (backupId: string) =>
        store.versions.filter((v) => v.backup_id === backupId && visible(v)),
      getVersionOwned: async () => null,
      getVersionForCommitOwned: async (params: {
        userId: string;
        backupId: string;
        versionId: string;
      }) => {
        const row = store.versions.find(
          (v) =>
            v.id === params.versionId &&
            v.backup_id === params.backupId &&
            store.backups.get(v.backup_id)?.user_id === params.userId
        );
        return row
          ? {
              ...row,
              legacy_unverified: false,
            }
          : null;
      },
      findVersionByOperationOwned: async (params: { operationId: string }) => {
        store.operationLookups += 1;
        const row = store.versions.find(
          (version) => version.client_operation_id === params.operationId
        );
        return row ? { ...row, legacy_unverified: false } : null;
      },
      findVersionOperationOwned: async (params: { operationId: string }) => {
        const row = store.versions.find(
          (version) => version.client_operation_id === params.operationId
        );
        return row
          ? {
              user_id: store.backups.get(row.backup_id)?.user_id,
              backup_id: row.backup_id,
              operation_id: params.operationId,
              version_id: row.id,
              manifest_size_bytes: row.manifest_size_bytes,
              manifest_sha256: row.manifest_sha256,
              chunk_metadata: [
                {
                  index: 0,
                  encryptedSize: row.size_bytes - row.manifest_size_bytes,
                  sha256: "aa".repeat(32),
                },
              ],
              committed_at: row.committed_at,
            }
          : null;
      },
      leaseVersionForReplayOwned: async (params: { operationId: string; ttlSeconds: number }) => {
        const row = store.versions.find(
          (version) => version.client_operation_id === params.operationId
        );
        if (!row || row.committed_at !== null || row.gc_reclaim_token !== null) {
          return null;
        }
        row.replay_fence_token = `replay-fence-${row.id}`;
        row.replay_fence_expires_at = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();
        return { ...row, legacy_unverified: false };
      },
      finalizeReplayFenceOwned: async (params: {
        versionId: string;
        replayFenceToken: string;
        expiresAt: Date;
      }) => {
        const row = store.versions.find((version) => version.id === params.versionId);
        if (
          !row ||
          row.gc_reclaim_token !== null ||
          row.replay_fence_token !== params.replayFenceToken
        ) {
          return false;
        }
        row.replay_fence_expires_at = params.expiresAt.toISOString();
        store.replayFenceFinalisations.push({
          token: params.replayFenceToken,
          expiresAt: params.expiresAt,
        });
        return true;
      },
      listChunksForVersion: async (versionId: string) => {
        const row = store.versions.find((version) => version.id === versionId);
        return row
          ? [
              {
                chunk_index: 0,
                size_bytes: row.size_bytes - row.manifest_size_bytes,
                sha256: Uint8Array.from(Buffer.from("aa".repeat(32), "hex")),
                object_key: `chunk/${row.id}/0`,
              },
            ]
          : [];
      },
      softDeleteVersionOwned: async () => 1,
    },
  });
  mock.module("../r2", {
    namedExports: {
      manifestKey: ({ versionId }: { versionId: string }) => `manifest/${versionId}`,
      chunkKey: ({ versionId, chunkIndex }: { versionId: string; chunkIndex: number }) =>
        `chunk/${versionId}/${chunkIndex}`,
      presignPut: async (key: string, options: unknown) => {
        store.putCalls.push({ key, options });
        return {
          url: "https://r2.test/put",
          expiresAt: store.nextPutExpiries.shift() ?? new Date(0),
        };
      },
      presignGet: async () => ({ url: "https://r2.test/get", expiresAt: new Date(0) }),
      headObject: async (key: string) => ({
        state: "present",
        contentLength: key.startsWith("manifest/")
          ? 10
          : Number(store.versions.find((row) => row.id === key.split("/")[1])?.size_bytes ?? 0),
        metadataSha256: key.startsWith("manifest/")
          ? createHash("sha256").update(Buffer.alloc(10)).digest("hex")
          : "aa".repeat(32),
      }),
    },
  });
}

function seedBackup(userId: string, backupId: string) {
  store.backups.set(backupId, { id: backupId, user_id: userId });
}

async function push(opts: {
  userId: string;
  backupId: string;
  requiresCommit?: boolean;
  size?: number;
  operationId?: string;
}) {
  const { createVersionWithUploads } = await import("../storage");
  return createVersionWithUploads({
    userId: opts.userId,
    backupId: opts.backupId,
    encryptedManifest: new Uint8Array(10),
    chunkMetadata: [{ index: 0, encryptedSize: opts.size ?? 100, sha256: "aa".repeat(32) }],
    requiresCommit: opts.requiresCommit,
    operationId: opts.operationId,
  });
}

beforeEach(() => setupMocks());
afterEach(() => mock.reset());

describe("clientRequiresVersionCommit — schema negotiation", () => {
  const cases: Array<[string | null | undefined, boolean, string]> = [
    [null, true, "an absent header is pending until bounded server reconciliation"],
    [undefined, true, "an undefined header is pending until server reconciliation"],
    ["", true, "an empty header is pending until server reconciliation"],
    ["2.0", true, "an explicit 2.0 client is pending until server reconciliation"],
    ["1.9", true, "an older client never makes a new version immediately visible"],
    ["2.1", true, "2.1 is the first schema with the commit endpoint"],
    ["2.10", true, "minor is compared numerically, not lexically"],
    ["3.0", true, "a future major also commits"],
    ["  2.1  ", true, "surrounding whitespace is tolerated"],
    ["banana", true, "an unparseable header is pending until server reconciliation"],
    ["2.1garbage", true, "a version prefix is malformed and stays on reconciliation"],
    ["3.0", true, "an unsupported major never opts into explicit commit"],
    ["2", true, "a major-only header is pending until server reconciliation"],
  ];

  for (const [header, expected, why] of cases) {
    it(`${JSON.stringify(header)} → ${expected} (${why})`, async () => {
      const { clientRequiresVersionCommit } = await import("../api-version");
      assert.equal(clientRequiresVersionCommit(header), expected);
    });
  }
});

describe("createVersionWithUploads — commit gating", () => {
  it("a 2.1 client gets an uncommitted version and NO retention prune", async () => {
    seedBackup("u-1", "b-1");
    const result = await push({ userId: "u-1", backupId: "b-1", requiresCommit: true });

    assert.equal(result.requiresCommit, true);
    assert.equal(store.pruneCalls, 0, "retention must not run before the bytes land");
    const row = store.versions.find((v) => v.id === result.versionId)!;
    assert.equal(row.requires_commit, true);
    assert.equal(row.committed_at, null);
    assert.equal(visible(row), false, "the version is not yet visible");
  });

  it("a 2.0 client stays pending and does not prune before server reconciliation", async () => {
    seedBackup("u-2", "b-2");
    const result = await push({ userId: "u-2", backupId: "b-2", requiresCommit: false });

    assert.equal(result.requiresCommit, true);
    assert.equal(store.pruneCalls, 0, "retention must wait for verified publication");
    const row = store.versions.find((v) => v.id === result.versionId)!;
    assert.equal(row.requires_commit, true);
    assert.equal(visible(row), false, "legacy clients are reconciled before visibility");
  });

  it("defaults to pending when the caller says nothing", async () => {
    seedBackup("u-3", "b-3");
    const result = await push({ userId: "u-3", backupId: "b-3" });
    assert.equal(result.requiresCommit, true);
    assert.equal(store.pruneCalls, 0);
  });

  it("an uncommitted version does not consume quota", async () => {
    seedBackup("u-4", "b-4");
    const created = await push({
      userId: "u-4",
      backupId: "b-4",
      requiresCommit: true,
      size: 1000,
    });
    const { sumActiveStorageForUser } = await import("../db");
    assert.equal(await sumActiveStorageForUser("u-4"), 0, "nothing is charged before commit");

    const { commitVersionUpload } = await import("../storage");
    await commitVersionUpload({
      userId: "u-4",
      backupId: "b-4",
      versionId: created.versionId,
    });
    assert.equal(
      await sumActiveStorageForUser("u-4"),
      1010,
      "charged only once the bytes are confirmed (1000 chunk + 10 manifest)"
    );
  });

  it("returns quota exceeded after one replay lookup instead of recursively retrying an operation ID", async () => {
    seedBackup("u-quota", "b-quota");
    store.forceInsertNull = true;
    const { createVersionWithUploads } = await import("../storage");

    await assert.rejects(
      createVersionWithUploads({
        userId: "u-quota",
        backupId: "b-quota",
        encryptedManifest: new Uint8Array(10),
        chunkMetadata: [{ index: 0, encryptedSize: 100, sha256: "aa".repeat(32) }],
        operationId: "quota-operation-id",
      }),
      (err: Error) => (err as unknown as { code: string }).code === "STORAGE_QUOTA_EXCEEDED"
    );
    assert.equal(store.operationLookups, 2, "initial lookup plus one raced-insert lookup");
  });

  it("replays a pending operation with the same version and fresh checksum-bound PUT URLs", async () => {
    seedBackup("u-pending", "b-pending");
    const first = await push({ userId: "u-pending", backupId: "b-pending", operationId: "push-1" });
    store.putCalls = [];

    const replay = await push({
      userId: "u-pending",
      backupId: "b-pending",
      operationId: "push-1",
    });

    assert.equal(replay.versionId, first.versionId);
    assert.equal(replay.alreadyCommitted, undefined);
    assert.equal(store.putCalls.length, 2, "the manifest and chunk URLs are minted again");
    for (const call of store.putCalls) {
      assert.deepEqual(call.options, {
        contentLength: call.key.startsWith("manifest/") ? 10 : 100,
        ifNoneMatchStar: true,
        sha256Hex: call.key.startsWith("manifest/")
          ? createHash("sha256").update(Buffer.alloc(10)).digest("hex")
          : "aa".repeat(32),
      });
    }
  });

  it("extends the replay fence through the latest URL after signing delay", async () => {
    seedBackup("u-fence", "b-fence");
    await push({ userId: "u-fence", backupId: "b-fence", operationId: "push-1" });
    store.putCalls = [];
    store.nextPutExpiries = [
      new Date("2030-01-01T00:01:00.000Z"),
      new Date("2030-01-01T00:03:00.000Z"),
    ];

    await push({ userId: "u-fence", backupId: "b-fence", operationId: "push-1" });

    assert.deepEqual(store.replayFenceFinalisations, [
      {
        token: `replay-fence-${store.versions[0].id}`,
        expiresAt: new Date("2030-01-01T00:04:00.000Z"),
      },
    ]);
    assert.equal(
      store.versions[0].replay_fence_expires_at,
      "2030-01-01T00:04:00.000Z",
      "a GC pass after the provisional lease would still observe the actual latest URL lifetime"
    );
  });

  it("replays a committed operation as the terminal result without PUT URLs", async () => {
    seedBackup("u-replay", "b-replay");
    const first = await push({ userId: "u-replay", backupId: "b-replay", operationId: "push-1" });
    store.versions.find((row) => row.id === first.versionId)!.committed_at =
      new Date().toISOString();

    const replay = await push({ userId: "u-replay", backupId: "b-replay", operationId: "push-1" });

    assert.equal(replay.versionId, first.versionId);
    assert.equal(replay.alreadyCommitted, true);
    assert.deepEqual(replay.uploadUrls, []);
  });

  it("rejects a replay whose payload differs without inserting another version", async () => {
    seedBackup("u-mismatch", "b-mismatch");
    await push({ userId: "u-mismatch", backupId: "b-mismatch", operationId: "push-1" });
    const { createVersionWithUploads } = await import("../storage");

    await assert.rejects(
      createVersionWithUploads({
        userId: "u-mismatch",
        backupId: "b-mismatch",
        encryptedManifest: new Uint8Array(11),
        chunkMetadata: [{ index: 0, encryptedSize: 100, sha256: "aa".repeat(32) }],
        operationId: "push-1",
      }),
      (err: Error) => (err as unknown as { code: string }).code === "OPERATION_PAYLOAD_MISMATCH"
    );
    assert.equal(store.versions.length, 1);
  });

  it("does not replay or mint URLs while GC owns the pending version", async () => {
    seedBackup("u-reclaim", "b-reclaim");
    await push({ userId: "u-reclaim", backupId: "b-reclaim", operationId: "push-1" });
    store.versions[0].gc_reclaim_token = "reclaim-token";

    await assert.rejects(
      push({ userId: "u-reclaim", backupId: "b-reclaim", operationId: "push-1" }),
      (err: Error) => (err as unknown as { code: string }).code === "VERSION_RECLAIM_IN_PROGRESS"
    );

    const { commitVersionUpload } = await import("../storage");
    await assert.rejects(
      commitVersionUpload({
        userId: "u-reclaim",
        backupId: "b-reclaim",
        versionId: store.versions[0].id,
      }),
      (err: Error) => (err as unknown as { code: string }).code === "VERSION_RECLAIM_IN_PROGRESS"
    );
  });
});

describe("commitVersionUpload — publish + retention", () => {
  it("makes the version visible and prunes retention exactly once", async () => {
    seedBackup("u-5", "b-5");
    const created = await push({ userId: "u-5", backupId: "b-5", requiresCommit: true });
    const { commitVersionUpload } = await import("../storage");

    const first = await commitVersionUpload({
      userId: "u-5",
      backupId: "b-5",
      versionId: created.versionId,
    });
    assert.equal(first.alreadyCommitted, false);
    assert.equal(typeof first.committedAt, "string");
    assert.equal(store.pruneCalls, 1, "retention runs on commit, not on create");
    assert.equal(visible(store.versions[0]), true);
  });

  it("is idempotent: a replay re-prunes nothing and keeps the original timestamp", async () => {
    seedBackup("u-6", "b-6");
    const created = await push({ userId: "u-6", backupId: "b-6", requiresCommit: true });
    const { commitVersionUpload } = await import("../storage");

    const first = await commitVersionUpload({
      userId: "u-6",
      backupId: "b-6",
      versionId: created.versionId,
    });
    const second = await commitVersionUpload({
      userId: "u-6",
      backupId: "b-6",
      versionId: created.versionId,
    });

    assert.equal(second.alreadyCommitted, true);
    assert.equal(second.committedAt, first.committedAt);
    assert.equal(second.prunedVersions, 0);
    assert.equal(store.pruneCalls, 1, "the destructive half runs at most once");
  });

  it("a failed push evicts nothing — the previous good version survives", async () => {
    seedBackup("u-7", "b-7");
    const good: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await push({ userId: "u-7", backupId: "b-7", requiresCommit: true });
      const { commitVersionUpload } = await import("../storage");
      await commitVersionUpload({
        userId: "u-7",
        backupId: "b-7",
        versionId: created.versionId,
      });
      good.push(created.versionId);
    }
    const pruneCallsAfterGoodPushes = store.pruneCalls;

    // Sixth push dies before commit.
    await push({ userId: "u-7", backupId: "b-7", requiresCommit: true });

    assert.equal(store.pruneCalls, pruneCallsAfterGoodPushes, "no prune was triggered");
    const stillVisible = store.versions.filter(visible).map((v) => v.id);
    assert.deepEqual([...stillVisible].sort(), [...good].sort());
  });

  it("cross-user commit is NOT_FOUND, and leaves the owner untouched", async () => {
    seedBackup("u-8", "b-8");
    const created = await push({ userId: "u-8", backupId: "b-8", requiresCommit: true });
    const { commitVersionUpload } = await import("../storage");

    await assert.rejects(
      commitVersionUpload({
        userId: "attacker",
        backupId: "b-8",
        versionId: created.versionId,
      }),
      (err: Error) => (err as unknown as { code: string }).code === "NOT_FOUND"
    );
    assert.equal(store.pruneCalls, 0, "a rejected commit must not prune anything");
    assert.equal(store.versions[0].committed_at, null);
  });

  it("an unknown version id is NOT_FOUND", async () => {
    seedBackup("u-9", "b-9");
    const { commitVersionUpload } = await import("../storage");
    await assert.rejects(
      commitVersionUpload({ userId: "u-9", backupId: "b-9", versionId: "no-such-version" }),
      (err: Error) => (err as unknown as { code: string }).code === "NOT_FOUND"
    );
  });
});
