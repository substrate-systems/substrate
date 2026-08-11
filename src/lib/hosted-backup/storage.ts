/**
 * Higher-level storage orchestration: backup CRUD, version creation with
 * per-chunk presigned URL minting, quota enforcement, retention enforcement.
 * Treats not-found and not-owned identically (returns null / 404) per
 * contract §7.
 */

import { randomUUID } from "node:crypto";
import {
  insertBackup,
  listBackupsForUser as dbListBackups,
  getBackupOwned,
  deleteBackupOwned,
  updateBackupOwned,
  listVersions,
  getVersionOwned,
  getVersionForCommitOwned,
  findVersionOperationOwned,
  leaseVersionForReplayOwned,
  finalizeReplayFenceOwned,
  listChunksForVersion,
  softDeleteVersionOwned,
  insertVersionWithChunks,
  commitVersion,
  type BackupRow,
  type BackupSummaryRow,
  type BackupVersionRow,
  type BackupVersionOperationRow,
  type BackupChunkRow,
} from "./db";
import { chunkKey, manifestKey, presignGet, presignPut, headObject } from "./r2";
import { errors } from "./errors";
import {
  DEFAULT_QUOTA_BYTES,
  PRESIGNED_URL_TTL_S,
  VERSION_RETENTION,
  type ChunkMetadata,
  type UploadUrl,
  type VersionSummary,
  type BackupSummary,
} from "./types";

// The database lease is deliberately longer than the signed URL lifetime so
// ordinary database/application clock skew cannot let GC reclaim a generation
// while a caller still holds a valid replacement URL.
const REPLAY_FENCE_CLOCK_SKEW_SECONDS = 60;
const REPLAY_FENCE_TTL_SECONDS = PRESIGNED_URL_TTL_S + REPLAY_FENCE_CLOCK_SKEW_SECONDS;

/**
 * The storage quota limit in bytes (contract §8). Default 1 GiB, overridable via
 * HOSTED_BACKUP_QUOTA_BYTES. Single source of truth for both quota enforcement
 * (below) and the account/me `quotaTotalBytes` surface, so the total the GUI
 * displays always equals the limit actually enforced. (Per-plan limits are not
 * modelled yet — a future enhancement.)
 */
export function getQuotaBytes(): number {
  const override = process.env.HOSTED_BACKUP_QUOTA_BYTES;
  if (!override) return DEFAULT_QUOTA_BYTES;
  const parsed = Number(override);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUOTA_BYTES;
  return parsed;
}

export async function createBackup(params: { userId: string; name: string }): Promise<BackupRow> {
  return insertBackup(params);
}

export async function listBackups(userId: string): Promise<BackupSummary[]> {
  const rows = await dbListBackups(userId);
  return rows.map((r: BackupSummaryRow) => ({
    id: r.id,
    name: r.name,
    latestVersionId: r.latest_version_id,
    versionCount: Number(r.version_count),
    totalSize: Number(r.total_size),
    updatedAt: r.updated_at,
  }));
}

export async function deleteBackup(params: {
  userId: string;
  backupId: string;
}): Promise<{ removed: boolean; r2Prefix: string }> {
  const removed = await deleteBackupOwned(params.userId, params.backupId);
  return {
    removed: removed > 0,
    r2Prefix: `users/${params.userId}/backups/${params.backupId}/`,
  };
}

/**
 * Update a backup's mutable metadata (the first instance of a general
 * update-backup-metadata primitive). `patch` is partial — today only `name`;
 * future fields extend `patch` + `updateBackupOwned` without a new route.
 * Throws notFound when the backup does not exist or is not owned.
 */
export async function updateBackup(params: {
  userId: string;
  backupId: string;
  patch: { name?: string };
}): Promise<{ id: string; name: string; updatedAt: string }> {
  const row = await updateBackupOwned(params.userId, params.backupId, {
    name: params.patch.name,
  });
  if (!row) throw errors.notFound("backup not found");
  return { id: row.id, name: row.name, updatedAt: row.updated_at };
}

export async function listVersionsOwned(params: {
  userId: string;
  backupId: string;
}): Promise<VersionSummary[]> {
  const owner = await getBackupOwned(params.userId, params.backupId);
  if (!owner) throw errors.notFound("backup not found");
  const rows = await listVersions(params.backupId);
  return rows.map((v: BackupVersionRow) => ({
    versionId: v.id,
    createdAt: v.created_at,
    size: Number(v.size_bytes),
    manifestSha256: Buffer.from(v.manifest_sha256).toString("hex"),
  }));
}

export async function softDeleteVersion(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): Promise<void> {
  const removed = await softDeleteVersionOwned(params);
  if (removed === 0) throw errors.notFound("version not found");
}

/**
 * Creates a version + chunks transactionally, mints presigned PUT URLs, and
 * enforces quota before insert. Returns the new versionId, the per-chunk
 * upload URLs, and whether the caller must commit.
 *
 * Every row starts invisible, regardless of the client API version. Clients
 * that know the commit endpoint publish explicitly; the bounded server
 * reconciliation path proves legacy clients' R2 objects before publication.
 */
export async function createVersionWithUploads(params: {
  userId: string;
  backupId: string;
  encryptedManifest: Uint8Array;
  chunkMetadata: ChunkMetadata[];
  requiresCommit?: boolean;
  clientCommitRequired?: boolean;
  operationId?: string;
}): Promise<{
  versionId: string;
  uploadUrls: UploadUrl[];
  requiresCommit: boolean;
  alreadyCommitted?: boolean;
}> {
  const owner = await getBackupOwned(params.userId, params.backupId);
  if (!owner) throw errors.notFound("backup not found");

  if (!Array.isArray(params.chunkMetadata) || params.chunkMetadata.length === 0) {
    throw errors.badRequest("chunkMetadata must be a non-empty array");
  }

  // Validate chunk metadata
  for (let i = 0; i < params.chunkMetadata.length; i++) {
    const c = params.chunkMetadata[i];
    if (typeof c.index !== "number" || c.index < 0) {
      throw errors.badRequest(`chunk[${i}].index must be a non-negative integer`);
    }
    if (typeof c.encryptedSize !== "number" || c.encryptedSize <= 0) {
      throw errors.badRequest(`chunk[${i}].encryptedSize must be > 0`);
    }
    if (typeof c.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(c.sha256)) {
      throw errors.badRequest(`chunk[${i}].sha256 must be 64 hex chars`);
    }
  }

  const totalSize = params.chunkMetadata.reduce(
    (acc, c) => acc + c.encryptedSize,
    params.encryptedManifest.length
  );

  const limit = getQuotaBytes();
  const manifestSha256 = await sha256Hex(params.encryptedManifest);

  const replay = params.operationId ? await replayVersionOperation(params, manifestSha256) : null;
  if (replay) return replay;

  const versionId = randomUUID();
  const versionManifestKey = manifestKey({
    userId: params.userId,
    backupId: params.backupId,
    versionId,
  });
  const chunks = params.chunkMetadata.map((c) => ({
    index: c.index,
    objectKey: chunkKey({
      userId: params.userId,
      backupId: params.backupId,
      versionId,
      chunkIndex: c.index,
    }),
    sizeBytes: c.encryptedSize,
    sha256: hexToBytes(c.sha256),
  }));

  const requiresCommit = true;

  const inserted = await insertVersionWithChunks({
    userId: params.userId,
    quotaBytes: limit,
    versionId,
    backupId: params.backupId,
    sizeBytes: totalSize,
    manifestSizeBytes: params.encryptedManifest.length,
    manifestObjectKey: versionManifestKey,
    manifestSha256: hexToBytes(manifestSha256),
    chunkCount: params.chunkMetadata.length,
    requiresCommit,
    clientCommitRequired: params.clientCommitRequired ?? true,
    clientOperationId: params.operationId ?? null,
    operationChunkMetadata: params.chunkMetadata,
    chunks,
  });
  if (!inserted) {
    const raced = params.operationId ? await replayVersionOperation(params, manifestSha256) : null;
    if (raced) return raced;
    throw errors.storageQuotaExceeded({ additionBytes: totalSize, limitBytes: limit });
  }

  const uploadUrls: UploadUrl[] = [];
  // Manifest PUT URL is one of the upload URLs, marked with chunkIndex = -1
  // so the engine knows where to PUT the manifest blob.
  const manifestSigned = await presignPut(versionManifestKey, {
    contentLength: params.encryptedManifest.length,
    ifNoneMatchStar: params.clientCommitRequired === true,
    sha256Hex: params.clientCommitRequired === true ? manifestSha256 : undefined,
  });
  uploadUrls.push({
    chunkIndex: -1,
    presignedUrl: manifestSigned.url,
    expiresAt: manifestSigned.expiresAt.toISOString(),
  });
  for (const ch of chunks) {
    const signed = await presignPut(ch.objectKey, {
      contentLength: ch.sizeBytes,
      ifNoneMatchStar: params.clientCommitRequired === true,
      sha256Hex:
        params.clientCommitRequired === true ? Buffer.from(ch.sha256).toString("hex") : undefined,
    });
    uploadUrls.push({
      chunkIndex: ch.index,
      presignedUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    });
  }

  return { versionId, uploadUrls, requiresCommit };
}

async function replayVersionOperation(
  params: Parameters<typeof createVersionWithUploads>[0],
  manifestSha256: string
): Promise<{
  versionId: string;
  uploadUrls: UploadUrl[];
  requiresCommit: boolean;
  alreadyCommitted?: boolean;
} | null> {
  if (!params.operationId) return null;
  const existing = await findVersionOperationOwned({
    userId: params.userId,
    backupId: params.backupId,
    operationId: params.operationId,
  });
  if (!existing) return null;
  await assertOperationPayloadMatches(existing, params, manifestSha256);
  if (existing.committed_at !== null) {
    return {
      versionId: existing.version_id,
      uploadUrls: [],
      requiresCommit: true,
      alreadyCommitted: true,
    };
  }

  const leased = await leaseVersionForReplayOwned({
    userId: params.userId,
    backupId: params.backupId,
    operationId: params.operationId,
    ttlSeconds: REPLAY_FENCE_TTL_SECONDS,
  });
  if (leased) {
    const uploadUrls = await regenerateUploadUrls(leased);
    const latestUrlExpiry = new Date(
      Math.max(...uploadUrls.map((uploadUrl) => Date.parse(uploadUrl.expiresAt)))
    );
    const replayFenceToken = leased.replay_fence_token;
    if (
      !replayFenceToken ||
      !(await finalizeReplayFenceOwned({
        userId: params.userId,
        backupId: params.backupId,
        versionId: leased.id,
        replayFenceToken,
        expiresAt: new Date(latestUrlExpiry.getTime() + REPLAY_FENCE_CLOCK_SKEW_SECONDS * 1000),
      }))
    ) {
      throw errors.versionReplayInProgress();
    }
    return {
      versionId: leased.id,
      uploadUrls,
      requiresCommit: true,
    };
  }

  const current = await getVersionForCommitOwned({
    userId: params.userId,
    backupId: params.backupId,
    versionId: existing.version_id,
  });
  if (current) assertVersionNotReclaiming(current);

  // A concurrent commit can win between the first operation lookup and the
  // replay lease. Re-read the durable operation record before reporting busy.
  const refreshed = await findVersionOperationOwned({
    userId: params.userId,
    backupId: params.backupId,
    operationId: params.operationId,
  });
  if (refreshed && refreshed.committed_at !== null) {
    return {
      versionId: refreshed.version_id,
      uploadUrls: [],
      requiresCommit: true,
      alreadyCommitted: true,
    };
  }
  throw errors.versionReplayInProgress();
}

async function assertOperationPayloadMatches(
  existing: BackupVersionOperationRow,
  params: Pick<
    Parameters<typeof createVersionWithUploads>[0],
    "encryptedManifest" | "chunkMetadata"
  >,
  manifestSha256: string
): Promise<void> {
  if (
    Number(existing.manifest_size_bytes) !== params.encryptedManifest.length ||
    Buffer.from(existing.manifest_sha256).toString("hex") !== manifestSha256
  ) {
    throw errors.operationPayloadMismatch();
  }
  if (existing.chunk_metadata.length !== params.chunkMetadata.length) {
    throw errors.operationPayloadMismatch();
  }
  const byIndex = new Map(existing.chunk_metadata.map((chunk) => [chunk.index, chunk]));
  for (const chunk of params.chunkMetadata) {
    const saved = byIndex.get(chunk.index);
    if (
      !saved ||
      Number(saved.encryptedSize) !== chunk.encryptedSize ||
      saved.sha256.toLowerCase() !== chunk.sha256.toLowerCase()
    ) {
      throw errors.operationPayloadMismatch();
    }
  }
}

function assertVersionNotReclaiming(version: BackupVersionRow): void {
  if (version.gc_reclaim_token) throw errors.versionReclaimInProgress();
}

async function regenerateUploadUrls(version: BackupVersionRow): Promise<UploadUrl[]> {
  const chunks = await listChunksForVersion(version.id);
  const manifestSigned = await presignPut(version.manifest_object_key, {
    contentLength: Number(version.manifest_size_bytes),
    ifNoneMatchStar: version.client_commit_required,
    sha256Hex: version.client_commit_required
      ? Buffer.from(version.manifest_sha256).toString("hex")
      : undefined,
  });
  const uploadUrls: UploadUrl[] = [
    {
      chunkIndex: -1,
      presignedUrl: manifestSigned.url,
      expiresAt: manifestSigned.expiresAt.toISOString(),
    },
  ];
  for (const chunk of chunks) {
    const signed = await presignPut(chunk.object_key, {
      contentLength: Number(chunk.size_bytes),
      ifNoneMatchStar: version.client_commit_required,
      sha256Hex: version.client_commit_required
        ? Buffer.from(chunk.sha256).toString("hex")
        : undefined,
    });
    uploadUrls.push({
      chunkIndex: chunk.chunk_index,
      presignedUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    });
  }
  return uploadUrls;
}

/**
 * Second phase of the push: the client has PUT every chunk and the manifest,
 * so the version becomes visible and the §8 retention cap is applied — in
 * that order, and only now. Retention pruning is the destructive half of the
 * operation, so it is deliberately gated behind evidence that the new version
 * actually exists; a push that dies before this call prunes nothing.
 *
 * Idempotent. A repeat call returns the original `committedAt` with
 * `alreadyCommitted: true` and skips the prune entirely, so replays (retries,
 * at-least-once delivery, an impatient client) cannot cascade deletions.
 *
 * Not-found and not-owned are indistinguishable (404), matching every other
 * `/api/backups/*` route per contract §7.
 */
export async function commitVersionUpload(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): Promise<{
  versionId: string;
  committedAt: string;
  alreadyCommitted: boolean;
  prunedVersions: number;
}> {
  const version = await getVersionForCommitOwned(params);
  if (!version) throw errors.notFound("version not found");
  assertVersionNotReclaiming(version);

  if (version.committed_at === null) {
    const chunks = await listChunksForVersion(params.versionId);
    const expected = [
      {
        key: version.manifest_object_key,
        size: Number(version.manifest_size_bytes),
        kind: "manifest",
        sha256Hex: version.client_commit_required
          ? Buffer.from(version.manifest_sha256).toString("hex")
          : undefined,
        checksumSha256: version.client_commit_required
          ? Buffer.from(version.manifest_sha256).toString("base64")
          : undefined,
      },
      ...chunks.map((chunk) => ({
        key: chunk.object_key,
        size: Number(chunk.size_bytes),
        kind: `chunk ${chunk.chunk_index}`,
        sha256Hex: version.client_commit_required
          ? Buffer.from(chunk.sha256).toString("hex")
          : undefined,
        checksumSha256: version.client_commit_required
          ? Buffer.from(chunk.sha256).toString("base64")
          : undefined,
      })),
    ];
    await verifyExpectedObjects(expected);
  }

  const result = await commitVersion({ ...params, retain: VERSION_RETENTION });
  if (!result) {
    // A reclaim lease may have started between the ownership lookup and the
    // publication CAS. Re-read once so that race stays retryable rather than
    // masquerading as a not-found version.
    const current = await getVersionForCommitOwned(params);
    if (current) assertVersionNotReclaiming(current);
    throw errors.notFound("version not found");
  }

  return {
    versionId: params.versionId,
    committedAt: result.committedAt,
    alreadyCommitted: result.alreadyCommitted,
    prunedVersions: result.prunedVersions,
  };
}

const HEAD_CONCURRENCY = 4;

async function verifyExpectedObjects(
  expected: Array<{
    key: string;
    size: number;
    kind: string;
    sha256Hex?: string;
    checksumSha256?: string;
  }>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < expected.length) {
      const item = expected[next++];
      const result = await headObject(item.key);
      if (
        result.state !== "present" ||
        result.contentLength !== item.size ||
        (item.sha256Hex !== undefined && result.metadataSha256 !== item.sha256Hex) ||
        (item.checksumSha256 !== undefined &&
          result.checksumSha256 !== undefined &&
          result.checksumSha256 !== item.checksumSha256)
      ) {
        throw errors.uploadIncomplete({
          object: item.kind,
          expectedBytes: item.size,
          actualBytes: result.contentLength ?? null,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, expected.length) }, worker));
}

export async function getDownloadUrls(params: {
  userId: string;
  backupId: string;
  versionId: string;
  chunkIndices: number[];
}): Promise<UploadUrl[]> {
  const version = await getVersionOwned(params);
  if (!version) throw errors.notFound("version not found");
  const allChunks = await listChunksForVersion(params.versionId);
  const byIndex = new Map<number, BackupChunkRow>(allChunks.map((c) => [c.chunk_index, c]));

  // Validate all requested indices exist. The sentinel -1 is the manifest,
  // stored on the version row (not in `backup_chunks`), so it's always
  // valid for any owned version and is excluded from the chunk-table check.
  // This mirrors the upload path in `createVersionWithUploads`, which emits
  // the manifest URL with chunkIndex = -1. Any other negative index is a
  // genuine not-found.
  for (const idx of params.chunkIndices) {
    if (idx === -1) continue;
    if (!byIndex.has(idx)) {
      throw errors.notFound(`chunk index ${idx} not found`);
    }
  }

  const urls: UploadUrl[] = [];
  if (params.chunkIndices.includes(-1)) {
    const signed = await presignGet(version.manifest_object_key);
    urls.push({
      chunkIndex: -1,
      presignedUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    });
  }
  for (const idx of params.chunkIndices) {
    if (idx === -1) continue;
    const chunk = byIndex.get(idx)!;
    const signed = await presignGet(chunk.object_key);
    urls.push({
      chunkIndex: idx,
      presignedUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    });
  }
  return urls;
}

// --- helpers ---

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const _internal = { getQuotaBytes };
