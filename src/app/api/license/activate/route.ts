import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  LicenseKeyError,
  decodeAndVerifyLicenseKey,
  signActivationCanonical,
} from '@/lib/license/crypto';
import {
  countDevices,
  findDeviceByFingerprint,
  findLicenseByKey,
  insertDevice,
} from '@/lib/license/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEVICE_LIMIT = 3;

type Body = {
  key?: unknown;
  fingerprint?: unknown;
  machine_name?: unknown;
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
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
  const machineName =
    typeof body.machine_name === 'string' && body.machine_name.length > 0
      ? body.machine_name
      : null;

  if (!key || !fingerprint) {
    return NextResponse.json(
      { error: 'bad_request', message: 'key and fingerprint are required' },
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

  const existing = await findDeviceByFingerprint(license.id, fingerprint);
  if (existing) {
    return buildActivationResponse({
      licenseKey: license.license_key,
      instanceId: existing.instance_id,
      licenseId: license.id,
      fingerprint: existing.fingerprint,
      activatedAt: existing.activated_at,
    });
  }

  const used = await countDevices(license.id);
  if (used >= DEVICE_LIMIT) {
    return NextResponse.json(
      {
        error: 'activation_limit_reached',
        message: `This license is already activated on ${DEVICE_LIMIT} devices. Deactivate a device first.`,
        limit: DEVICE_LIMIT,
      },
      { status: 409 },
    );
  }

  const instanceId = randomUUID();
  const device = await insertDevice({
    licenseId: license.id,
    fingerprint,
    machineName,
    instanceId,
  });

  return buildActivationResponse({
    licenseKey: license.license_key,
    instanceId: device.instance_id,
    licenseId: license.id,
    fingerprint: device.fingerprint,
    activatedAt: device.activated_at,
  });
}

async function buildActivationResponse(params: {
  licenseKey: string;
  instanceId: string;
  licenseId: string;
  fingerprint: string;
  activatedAt: string;
}): Promise<NextResponse> {
  const activatedAtIso = new Date(params.activatedAt).toISOString();
  const fields = {
    activated: true,
    instance_id: params.instanceId,
    license_id: params.licenseId,
    fingerprint: params.fingerprint,
    activated_at: activatedAtIso,
  };
  const signature = await signActivationCanonical({
    licenseKey: params.licenseKey,
    fingerprint: params.fingerprint,
    activatedAt: activatedAtIso,
    expiresAt: '',
  });
  return NextResponse.json({ ...fields, signature }, { status: 200 });
}
