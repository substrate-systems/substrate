import { NextRequest, NextResponse } from 'next/server';
import {
  LicenseKeyError,
  decodeAndVerifyLicenseKey,
} from '@/lib/license/crypto';
import {
  deleteDeviceByInstanceId,
  findDeviceByInstanceId,
  findLicenseByKey,
} from '@/lib/license/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  key?: unknown;
  instance_id?: unknown;
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', message: 'invalid JSON body' },
      { status: 400 },
    );
  }

  const key = typeof body.key === 'string' ? body.key : '';
  const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';

  if (!key || !instanceId) {
    return NextResponse.json(
      { error: 'bad_request', message: 'key and instance_id are required' },
      { status: 400 },
    );
  }

  try {
    await decodeAndVerifyLicenseKey(key);
  } catch (err) {
    if (err instanceof LicenseKeyError) {
      const status = err.code === 'invalid_signature' ? 401 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    throw err;
  }

  const license = await findLicenseByKey(key);
  if (!license) {
    return NextResponse.json(
      { error: 'not_found', message: 'license not found' },
      { status: 404 },
    );
  }

  const device = await findDeviceByInstanceId(instanceId);
  if (!device || device.license_id !== license.id) {
    return NextResponse.json(
      { error: 'not_found', message: 'device not found for this license' },
      { status: 404 },
    );
  }

  const deleted = await deleteDeviceByInstanceId(instanceId);
  if (deleted === 0) {
    return NextResponse.json(
      { error: 'not_found', message: 'device not found for this license' },
      { status: 404 },
    );
  }

  return NextResponse.json({ deactivated: true }, { status: 200 });
}
