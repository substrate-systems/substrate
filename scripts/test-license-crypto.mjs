// Runtime smoke test for the license crypto module.
// Usage: ENDSTATE_LICENSE_PRIVATE_KEY=... node --experimental-strip-types scripts/test-license-crypto.mjs

import {
  createLicenseKey,
  decodeAndVerifyLicenseKey,
  signResponseFields,
  LicenseKeyError,
} from '../src/lib/license/crypto.ts';

async function main() {
  if (!process.env.ENDSTATE_LICENSE_PRIVATE_KEY) {
    console.error('set ENDSTATE_LICENSE_PRIVATE_KEY first');
    process.exit(1);
  }

  const payload = {
    email: 'test@example.com',
    transaction_id: 'txn_abc123',
    product: 'endstate-gui',
    issued_at: new Date().toISOString(),
  };

  const key = await createLicenseKey(payload);
  console.log('license key length:', key.length);

  const verified = await decodeAndVerifyLicenseKey(key);
  console.log('roundtrip verified:', JSON.stringify(verified));

  const buf = Buffer.from(key, 'base64');
  buf[Math.floor(buf.length / 2)] ^= 0x01;
  const tampered = buf.toString('base64');
  try {
    await decodeAndVerifyLicenseKey(tampered);
    console.error('FAIL: tampered key verified');
    process.exit(1);
  } catch (err) {
    if (err instanceof LicenseKeyError) {
      console.log('tampered key rejected:', err.code);
    } else {
      throw err;
    }
  }

  const sig = await signResponseFields({
    activated: true,
    instance_id: 'uuid-1',
    license_id: 'uuid-2',
    fingerprint: 'abc',
    activated_at: new Date().toISOString(),
  });
  console.log('activation response signature length:', sig.length);

  console.log('OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
