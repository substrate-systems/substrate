import { NextRequest } from 'next/server';
import { errors, errorResponse, HostedBackupError } from '@/lib/hosted-backup/errors';
import {
  requireReadAccess,
  requireWriteAccess,
} from '@/lib/hosted-backup/auth-middleware';
import { createBackup, listBackups } from '@/lib/hosted-backup/storage';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import type {
  CreateBackupResponse,
  ListBackupsResponse,
} from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireReadAccess(req);
    const backups = await listBackups(userId);
    const body: ListBackupsResponse = { backups };
    return jsonWithApiVersion(body, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup backups GET] unhandled:', err);
    }
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireWriteAccess(req);
    let body: { name?: unknown };
    try {
      body = (await req.json()) as { name?: unknown };
    } catch {
      throw errors.badRequest('invalid JSON body');
    }
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw errors.badRequest('name is required');
    }
    const backup = await createBackup({
      userId,
      name: body.name.trim().slice(0, 200),
    });
    const respBody: CreateBackupResponse = { backupId: backup.id };
    return jsonWithApiVersion(respBody, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup backups POST] unhandled:', err);
    }
    return errorResponse(err);
  }
}
