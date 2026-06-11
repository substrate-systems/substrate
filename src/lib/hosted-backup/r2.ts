/**
 * Cloudflare R2 client + presigned URL helpers.
 * R2 is fully S3-compatible at the API level, so we use the AWS S3 SDK with
 * the R2 endpoint. Per contract §8, presigned URL TTL is 5 minutes.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PRESIGNED_URL_TTL_S } from './types';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  const endpoint = process.env.ENDSTATE_R2_ENDPOINT;
  const accessKeyId = process.env.ENDSTATE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ENDSTATE_R2_SECRET_ACCESS_KEY;
  if (!endpoint) throw new Error('ENDSTATE_R2_ENDPOINT is not set');
  if (!accessKeyId) throw new Error('ENDSTATE_R2_ACCESS_KEY_ID is not set');
  if (!secretAccessKey) throw new Error('ENDSTATE_R2_SECRET_ACCESS_KEY is not set');
  _client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

function getBucket(): string {
  const bucket = process.env.ENDSTATE_R2_BUCKET;
  if (!bucket) throw new Error('ENDSTATE_R2_BUCKET is not set');
  return bucket;
}

export type PresignedUrl = {
  url: string;
  expiresAt: Date;
};

export async function presignPut(
  objectKey: string,
  opts?: { contentLength?: number; sha256Hex?: string },
): Promise<PresignedUrl> {
  const cmd = new PutObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
    ContentLength: opts?.contentLength,
  });
  const url = await getSignedUrl(getClient(), cmd, {
    expiresIn: PRESIGNED_URL_TTL_S,
  });
  return {
    url,
    expiresAt: new Date(Date.now() + PRESIGNED_URL_TTL_S * 1000),
  };
}

export async function presignGet(objectKey: string): Promise<PresignedUrl> {
  const cmd = new GetObjectCommand({
    Bucket: getBucket(),
    Key: objectKey,
  });
  const url = await getSignedUrl(getClient(), cmd, {
    expiresIn: PRESIGNED_URL_TTL_S,
  });
  return {
    url,
    expiresAt: new Date(Date.now() + PRESIGNED_URL_TTL_S * 1000),
  };
}

// --- GC primitives (backup-gc cron) ---

/**
 * Tri-state existence check. `'absent'` is returned ONLY on an explicit
 * not-found from R2; any other failure throws, so callers can distinguish
 * "definitively gone" from "couldn't tell" (the abandoned-upload sweep
 * soft-deletes on `'absent'` and must never do so on a transport error).
 */
export async function headObjectExists(
  objectKey: string,
): Promise<'present' | 'absent'> {
  try {
    await getClient().send(
      new HeadObjectCommand({ Bucket: getBucket(), Key: objectKey }),
    );
    return 'present';
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
      return 'absent';
    }
    throw err;
  }
}

/** One page of object keys under a prefix (page size ≤ 1000, R2/S3 limit). */
export async function listObjectKeys(
  prefix: string,
  continuationToken?: string,
): Promise<{ keys: string[]; nextToken?: string }> {
  const resp = await getClient().send(
    new ListObjectsV2Command({
      Bucket: getBucket(),
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }),
  );
  return {
    keys: (resp.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string'),
    nextToken: resp.IsTruncated ? resp.NextContinuationToken : undefined,
  };
}

/**
 * Batch-delete objects (chunks of ≤ 1000 keys per request, the S3 API cap).
 * Deleting a missing key is a success in S3 semantics, which is what makes
 * GC re-runs idempotent. Throws if R2 reports per-key errors.
 */
export async function deleteObjects(keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const resp = await getClient().send(
      new DeleteObjectsCommand({
        Bucket: getBucket(),
        Delete: { Objects: batch.map((k) => ({ Key: k })), Quiet: true },
      }),
    );
    const errs = resp.Errors ?? [];
    if (errs.length > 0) {
      throw new Error(
        `R2 DeleteObjects reported ${errs.length} error(s); first: ${errs[0].Key}: ${errs[0].Message}`,
      );
    }
    deleted += batch.length;
  }
  return deleted;
}

// --- Object key helpers ---

export function manifestKey(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): string {
  return `users/${params.userId}/backups/${params.backupId}/versions/${params.versionId}/manifest`;
}

export function chunkKey(params: {
  userId: string;
  backupId: string;
  versionId: string;
  chunkIndex: number;
}): string {
  return `users/${params.userId}/backups/${params.backupId}/versions/${params.versionId}/chunks/${params.chunkIndex}`;
}

export function userPrefix(userId: string): string {
  return `users/${userId}/`;
}

// Test seam — tests can inject a fake S3Client.
export function __setClient(client: S3Client | null): void {
  _client = client;
}
