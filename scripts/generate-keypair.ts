import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function main(): Promise<void> {
  const { secretKey, publicKey } = await ed.keygenAsync();

  const privHex = bytesToHex(secretKey);
  const pubHex = bytesToHex(publicKey);

  process.stdout.write(
    [
      '# Ed25519 keypair for Endstate license signing',
      '# Store the private key as an env var on the server; never commit it.',
      '# Embed the public key in the Tauri app for license verification.',
      '',
      `ENDSTATE_LICENSE_PRIVATE_KEY=${privHex}`,
      `ENDSTATE_LICENSE_PUBLIC_KEY=${pubHex}`,
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
