import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import { requireReadAccess } from '@/lib/hosted-backup/auth-middleware';
import { getDownloadUrls } from '@/lib/hosted-backup/storage';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type {
  DownloadUrlsRequest,
  DownloadUrlsResponse,
} from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ backupId: string; versionId: string }> },
) {
  try {
    const { userId } = await requireReadAccess(req);
    const { backupId, versionId } = await params;
    if (!backupId || !versionId) {
      throw errors.badRequest('backupId and versionId are required');
    }
    let body: DownloadUrlsRequest;
    try {
      body = (await req.json()) as DownloadUrlsRequest;
    } catch {
      throw errors.badRequest('invalid JSON body');
    }
    if (
      !Array.isArray(body.chunkIndices) ||
      body.chunkIndices.length === 0
    ) {
      throw errors.badRequest('chunkIndices must be a non-empty array');
    }
    if (
      !body.chunkIndices.every(
        (n) => typeof n === 'number' && Number.isInteger(n),
      )
    ) {
      throw errors.badRequest('chunkIndices must be integers');
    }

    const urls = await getDownloadUrls({
      userId,
      backupId,
      versionId,
      chunkIndices: body.chunkIndices,
    });
    const respBody: DownloadUrlsResponse = { urls };
    return jsonWithApiVersion(respBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup download-urls POST] unhandled:', err);
    }
    return errorResponse(err);
  }
}
