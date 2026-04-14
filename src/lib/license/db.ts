import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let _sql: NeonQueryFunction<false, true> | null = null;

function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): ReturnType<NeonQueryFunction<false, true>> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    _sql = neon(url, { fullResults: true });
  }
  return _sql(strings, ...values);
}

export type LicenseRow = {
  id: string;
  license_key: string;
  email: string;
  paddle_transaction_id: string;
  created_at: string;
};

export type DeviceRow = {
  id: string;
  license_id: string;
  fingerprint: string;
  machine_name: string | null;
  instance_id: string;
  activated_at: string;
};

export async function findLicenseByTransactionId(
  transactionId: string,
): Promise<LicenseRow | null> {
  const { rows } = await sql`
    SELECT id, license_key, email, paddle_transaction_id, created_at
    FROM licenses
    WHERE paddle_transaction_id = ${transactionId}
    LIMIT 1
  `;
  return (rows[0] as LicenseRow | undefined) ?? null;
}

export async function findLicenseByKey(
  key: string,
): Promise<LicenseRow | null> {
  const { rows } = await sql`
    SELECT id, license_key, email, paddle_transaction_id, created_at
    FROM licenses
    WHERE license_key = ${key}
    LIMIT 1
  `;
  return (rows[0] as LicenseRow | undefined) ?? null;
}

export async function insertLicense(params: {
  licenseKey: string;
  email: string;
  paddleTransactionId: string;
}): Promise<LicenseRow> {
  const { rows } = await sql`
    INSERT INTO licenses (license_key, email, paddle_transaction_id)
    VALUES (${params.licenseKey}, ${params.email}, ${params.paddleTransactionId})
    RETURNING id, license_key, email, paddle_transaction_id, created_at
  `;
  return rows[0] as LicenseRow;
}

export async function countDevices(licenseId: string): Promise<number> {
  const { rows } = await sql`
    SELECT COUNT(*)::text AS count FROM devices WHERE license_id = ${licenseId}
  `;
  return parseInt((rows[0] as { count: string }).count, 10);
}

export async function findDeviceByFingerprint(
  licenseId: string,
  fingerprint: string,
): Promise<DeviceRow | null> {
  const { rows } = await sql`
    SELECT id, license_id, fingerprint, machine_name, instance_id, activated_at
    FROM devices
    WHERE license_id = ${licenseId} AND fingerprint = ${fingerprint}
    LIMIT 1
  `;
  return (rows[0] as DeviceRow | undefined) ?? null;
}

export async function findDeviceByInstanceId(
  instanceId: string,
): Promise<DeviceRow | null> {
  const { rows } = await sql`
    SELECT id, license_id, fingerprint, machine_name, instance_id, activated_at
    FROM devices
    WHERE instance_id = ${instanceId}
    LIMIT 1
  `;
  return (rows[0] as DeviceRow | undefined) ?? null;
}

export async function insertDevice(params: {
  licenseId: string;
  fingerprint: string;
  machineName: string | null;
  instanceId: string;
}): Promise<DeviceRow> {
  const { rows } = await sql`
    INSERT INTO devices (license_id, fingerprint, machine_name, instance_id)
    VALUES (${params.licenseId}, ${params.fingerprint}, ${params.machineName}, ${params.instanceId})
    RETURNING id, license_id, fingerprint, machine_name, instance_id, activated_at
  `;
  return rows[0] as DeviceRow;
}

export async function deleteDeviceByInstanceId(
  instanceId: string,
): Promise<number> {
  const { rowCount } = await sql`
    DELETE FROM devices WHERE instance_id = ${instanceId}
  `;
  return rowCount ?? 0;
}
