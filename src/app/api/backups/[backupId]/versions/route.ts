import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import {
  requireReadAccess,
  requireWriteAccess,
} from '@/lib/hosted-backup/auth-middleware';
import {
  createVersionWithUploads,
  listVersionsOwned,
} from '@/lib/hosted-backup/storage';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type {
  CreateVersionRequest,
  CreateVersionResponse,
  ListVersionsResponse,
} from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string }> },
) {
  try {
    const { userId } = await requireReadAccess(req);
    const { backupId } = await params;
    if (!backupId) throw errors.badRequest('backupId is required');
    const versions = await listVersionsOwned({ userId, backupId });
    const body: ListVersionsResponse = { versions };
    return jsonWithApiVersion(body, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup versions GET] unhandled:', err);
    }
    return errorResponse(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string }> },
) {
  try {
    const { userId } = await requireWriteAccess(req);
    const { backupId } = await params;
    if (!backupId) throw errors.badRequest('backupId is required');

    let body: CreateVersionRequest;
    try {
      body = (await req.json()) as CreateVersionRequest;
    } catch {
      throw errors.badRequest('invalid JSON body');
    }
    if (typeof body.encryptedManifest !== 'string') {
      throw errors.badRequest('encryptedManifest is required');
    }
    const manifestBytes = new Uint8Array(
      Buffer.from(body.encryptedManifest, 'base64'),
    );
    if (manifestBytes.length === 0) {
      throw errors.badRequest('encryptedManifest must decode to non-empty bytes');
    }

    const result = await createVersionWithUploads({
      userId,
      backupId,
      encryptedManifest: manifestBytes,
      chunkMetadata: body.chunkMetadata,
    });

    const respBody: CreateVersionResponse = {
      versionId: result.versionId,
      uploadUrls: result.uploadUrls,
    };
    return jsonWithApiVersion(respBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup versions POST] unhandled:', err);
    }
    return errorResponse(err);
  }
}
