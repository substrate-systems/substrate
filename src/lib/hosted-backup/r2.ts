/**
 * Cloudflare R2 client + presigned URL helpers.
 * R2 is fully S3-compatible at the API level, so we use the AWS S3 SDK with
 * the R2 endpoint. Per contract §8, presigned URL TTL is 5 minutes.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PRESIGNED_URL_TTL_S } from './types';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint) throw new Error('R2_ENDPOINT is not set');
  if (!accessKeyId) throw new Error('R2_ACCESS_KEY_ID is not set');
  if (!secretAccessKey) throw new Error('R2_SECRET_ACCESS_KEY is not set');
  _client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error('R2_BUCKET is not set');
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
