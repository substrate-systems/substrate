/**
 * Generates an Ed25519 keypair for Hosted Backup JWT signing.
 *
 * Usage:
 *   tsx scripts/generate-jwt-keypair.ts            # print only
 *   tsx scripts/generate-jwt-keypair.ts --commit   # ALSO insert public key into signing_keys table
 *
 * Set the printed env vars in your hosting environment (Vercel, etc.):
 *   ENDSTATE_JWT_PRIVATE_KEY_HEX
 *   ENDSTATE_JWT_ACTIVE_KID
 */

import { randomBytes, randomUUID } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { neon } from '@neondatabase/serverless';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const commit = process.argv.includes('--commit');

  const seed = new Uint8Array(randomBytes(32));
  const { secretKey, publicKey } = await ed.keygenAsync(seed);
  // The "private key hex" we store is the seed — `keygenAsync` is
  // deterministic from it, mirroring `src/lib/license/crypto.ts`.
  const privateKeyHex = bytesToHex(seed);
  const publicKeyHex = bytesToHex(publicKey);
  const kid = `hb-${randomUUID()}`;

  console.log('# Hosted Backup JWT keypair');
  console.log(`ENDSTATE_JWT_PRIVATE_KEY_HEX=${privateKeyHex}`);
  console.log(`ENDSTATE_JWT_ACTIVE_KID=${kid}`);
  console.log(`# public key (hex): ${publicKeyHex}`);

  // secretKey isn't transmitted; it's derivable from the seed. Keep around to
  // mirror the noble shape; not printed.
  void secretKey;

  if (commit) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error('--commit set but DATABASE_URL is not. Aborting insert.');
      process.exit(1);
    }
    const sql = neon(url, { fullResults: true });
    await sql`
      INSERT INTO signing_keys (kid, public_key, algorithm)
      VALUES (${kid}, ${Buffer.from(publicKey)}, 'EdDSA')
    `;
    console.log(`# Inserted signing_keys row for kid=${kid}`);
  } else {
    console.log('# Re-run with --commit to insert the public key into signing_keys');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
