/**
 * Higher-level storage orchestration: backup CRUD, version creation with
 * per-chunk presigned URL minting, quota enforcement, retention enforcement.
 * Treats not-found and not-owned identically (returns null / 404) per
 * contract §7.
 */

import { randomUUID } from 'node:crypto';
import {
  insertBackup,
  listBackupsForUser as dbListBackups,
  getBackupOwned,
  deleteBackupOwned,
  updateBackupOwned,
  listVersions,
  getVersionOwned,
  listChunksForVersion,
  softDeleteVersionOwned,
  insertVersionWithChunks,
  softDeleteVersionsBeyondRetention,
  commitVersion,
  sumActiveStorageForUser,
  type BackupRow,
  type BackupSummaryRow,
  type BackupVersionRow,
  type BackupChunkRow,
} from './db';
import {
  chunkKey,
  manifestKey,
  presignGet,
  presignPut,
} from './r2';
import { errors } from './errors';
import {
  DEFAULT_QUOTA_BYTES,
  VERSION_RETENTION,
  type ChunkMetadata,
  type UploadUrl,
  type VersionSummary,
  type BackupSummary,
} from './types';

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

export async function createBackup(params: {
  userId: string;
  name: string;
}): Promise<BackupRow> {
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
  if (!row) throw errors.notFound('backup not found');
  return { id: row.id, name: row.name, updatedAt: row.updated_at };
}

export async function listVersionsOwned(params: {
  userId: string;
  backupId: string;
}): Promise<VersionSummary[]> {
  const owner = await getBackupOwned(params.userId, params.backupId);
  if (!owner) throw errors.notFound('backup not found');
  const rows = await listVersions(params.backupId);
  return rows.map((v: BackupVersionRow) => ({
    versionId: v.id,
    createdAt: v.created_at,
    size: Number(v.size_bytes),
    manifestSha256: Buffer.from(v.manifest_sha256).toString('hex'),
  }));
}

export async function softDeleteVersion(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): Promise<void> {
  const removed = await softDeleteVersionOwned(params);
  if (removed === 0) throw errors.notFound('version not found');
}

/**
 * Creates a version + chunks transactionally, mints presigned PUT URLs, and
 * enforces quota before insert. Returns the new versionId, the per-chunk
 * upload URLs, and whether the caller must commit.
 *
 * `requiresCommit` is negotiated by the route from the caller's
 * `X-Endstate-API-Version` header:
 *
 *   - true (schema >= 2.1) — the row is created invisible. It is not listed,
 *     not restorable, and not counted against quota until
 *     `commitVersionUpload` runs. Retention is NOT enforced here, because
 *     pruning before the bytes land is exactly how a failed push used to
 *     evict a genuinely good older version.
 *   - false (schema 2.0, or no header) — verbatim pre-2.1 behaviour: the row
 *     is live immediately and retention is enforced here, because such a
 *     client has no commit call and no other moment at which the §8 retention
 *     cap could be applied. This preserves both the visibility and the
 *     storage behaviour existing subscribers already have.
 */
export async function createVersionWithUploads(params: {
  userId: string;
  backupId: string;
  encryptedManifest: Uint8Array;
  chunkMetadata: ChunkMetadata[];
  requiresCommit?: boolean;
}): Promise<{ versionId: string; uploadUrls: UploadUrl[]; requiresCommit: boolean }> {
  const owner = await getBackupOwned(params.userId, params.backupId);
  if (!owner) throw errors.notFound('backup not found');

  if (!Array.isArray(params.chunkMetadata) || params.chunkMetadata.length === 0) {
    throw errors.badRequest('chunkMetadata must be a non-empty array');
  }

  // Validate chunk metadata
  for (let i = 0; i < params.chunkMetadata.length; i++) {
    const c = params.chunkMetadata[i];
    if (typeof c.index !== 'number' || c.index < 0) {
      throw errors.badRequest(`chunk[${i}].index must be a non-negative integer`);
    }
    if (typeof c.encryptedSize !== 'number' || c.encryptedSize <= 0) {
      throw errors.badRequest(`chunk[${i}].encryptedSize must be > 0`);
    }
    if (typeof c.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(c.sha256)) {
      throw errors.badRequest(`chunk[${i}].sha256 must be 64 hex chars`);
    }
  }

  const totalSize = params.chunkMetadata.reduce(
    (acc, c) => acc + c.encryptedSize,
    params.encryptedManifest.length,
  );

  const limit = getQuotaBytes();
  const current = await sumActiveStorageForUser(params.userId);
  if (current + totalSize > limit) {
    throw errors.storageQuotaExceeded({
      currentBytes: current,
      additionBytes: totalSize,
      limitBytes: limit,
    });
  }

  const versionId = randomUUID();
  const versionManifestKey = manifestKey({
    userId: params.userId,
    backupId: params.backupId,
    versionId,
  });
  const manifestSha256 = await sha256Hex(params.encryptedManifest);

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

  const requiresCommit = params.requiresCommit === true;

  await insertVersionWithChunks({
    versionId,
    backupId: params.backupId,
    sizeBytes: totalSize,
    manifestObjectKey: versionManifestKey,
    manifestSha256: hexToBytes(manifestSha256),
    chunkCount: params.chunkMetadata.length,
    requiresCommit,
    chunks,
  });

  // Retention moves to commit time for clients that commit — see the JSDoc
  // above. Schema-2.0 callers keep the create-time prune they have always had.
  if (!requiresCommit) {
    await softDeleteVersionsBeyondRetention({
      backupId: params.backupId,
      retain: VERSION_RETENTION,
    });
  }

  const uploadUrls: UploadUrl[] = [];
  // Manifest PUT URL is one of the upload URLs, marked with chunkIndex = -1
  // so the engine knows where to PUT the manifest blob.
  const manifestSigned = await presignPut(versionManifestKey);
  uploadUrls.push({
    chunkIndex: -1,
    presignedUrl: manifestSigned.url,
    expiresAt: manifestSigned.expiresAt.toISOString(),
  });
  for (const ch of chunks) {
    const signed = await presignPut(ch.objectKey, { contentLength: ch.sizeBytes });
    uploadUrls.push({
      chunkIndex: ch.index,
      presignedUrl: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    });
  }

  return { versionId, uploadUrls, requiresCommit };
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
  const result = await commitVersion(params);
  if (!result) throw errors.notFound('version not found');

  let prunedVersions = 0;
  if (!result.alreadyCommitted) {
    prunedVersions = await softDeleteVersionsBeyondRetention({
      backupId: params.backupId,
      retain: VERSION_RETENTION,
    });
  }

  return {
    versionId: params.versionId,
    committedAt: result.committedAt,
    alreadyCommitted: result.alreadyCommitted,
    prunedVersions,
  };
}

export async function getDownloadUrls(params: {
  userId: string;
  backupId: string;
  versionId: string;
  chunkIndices: number[];
}): Promise<UploadUrl[]> {
  const version = await getVersionOwned(params);
  if (!version) throw errors.notFound('version not found');
  const allChunks = await listChunksForVersion(params.versionId);
  const byIndex = new Map<number, BackupChunkRow>(
    allChunks.map((c) => [c.chunk_index, c]),
  );

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
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export const _internal = { getQuotaBytes };
