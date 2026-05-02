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
  listVersions,
  getVersionOwned,
  listChunksForVersion,
  softDeleteVersionOwned,
  insertVersionWithChunks,
  softDeleteVersionsBeyondRetention,
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

function getQuotaBytes(): number {
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
 * Creates a version + chunks transactionally, mints presigned PUT URLs,
 * enforces quota before insert, enforces retention after insert. Returns
 * the new versionId and the per-chunk upload URLs.
 */
export async function createVersionWithUploads(params: {
  userId: string;
  backupId: string;
  encryptedManifest: Uint8Array;
  chunkMetadata: ChunkMetadata[];
}): Promise<{ versionId: string; uploadUrls: UploadUrl[] }> {
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

  await insertVersionWithChunks({
    versionId,
    backupId: params.backupId,
    sizeBytes: totalSize,
    manifestObjectKey: versionManifestKey,
    manifestSha256: hexToBytes(manifestSha256),
    chunkCount: params.chunkMetadata.length,
    chunks,
  });

  await softDeleteVersionsBeyondRetention({
    backupId: params.backupId,
    retain: VERSION_RETENTION,
  });

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

  return { versionId, uploadUrls };
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

  // Validate all requested indices exist
  for (const idx of params.chunkIndices) {
    if (!byIndex.has(idx)) {
      throw errors.notFound(`chunk index ${idx} not found`);
    }
  }

  const urls: UploadUrl[] = [];
  // Always include the manifest as chunkIndex = -1
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
