import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

export type LicensePayload = {
  email: string;
  transaction_id: string;
  product: string;
  issued_at: string;
};

export type LicenseEnvelope = {
  payload: LicensePayload;
  signature: string;
};

const te = new TextEncoder();
const td = new TextDecoder();

let cachedKeyPair: { secretKey: Uint8Array; publicKey: Uint8Array } | null = null;
let cachedFromSecretHex: string | null = null;

async function getKeyPair(): Promise<{
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const hex = process.env.ENDSTATE_LICENSE_PRIVATE_KEY;
  if (!hex) throw new Error('ENDSTATE_LICENSE_PRIVATE_KEY is not set');
  if (cachedKeyPair && cachedFromSecretHex === hex) return cachedKeyPair;
  cachedKeyPair = await ed.keygenAsync(hexToBytes(hex));
  cachedFromSecretHex = hex;
  return cachedKeyPair;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function signBytes(msg: Uint8Array): Promise<Uint8Array> {
  const { secretKey } = await getKeyPair();
  return ed.signAsync(msg, secretKey);
}

export async function verifyBytes(
  sig: Uint8Array,
  msg: Uint8Array,
): Promise<boolean> {
  const { publicKey } = await getKeyPair();
  return ed.verifyAsync(sig, msg, publicKey);
}

export async function createLicenseKey(
  payload: LicensePayload,
): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const sig = await signBytes(te.encode(payloadJson));
  const envelope: LicenseEnvelope = {
    payload,
    signature: bytesToBase64(sig),
  };
  return bytesToBase64(te.encode(JSON.stringify(envelope)));
}

export async function decodeAndVerifyLicenseKey(
  key: string,
): Promise<LicensePayload> {
  let envelope: LicenseEnvelope;
  try {
    const json = td.decode(base64ToBytes(key));
    envelope = JSON.parse(json);
  } catch {
    throw new LicenseKeyError('invalid_key_format', 'License key is malformed');
  }
  if (!envelope?.payload || !envelope?.signature) {
    throw new LicenseKeyError('invalid_key_format', 'License key is malformed');
  }
  const ok = await verifyBytes(
    base64ToBytes(envelope.signature),
    te.encode(JSON.stringify(envelope.payload)),
  );
  if (!ok) {
    throw new LicenseKeyError(
      'invalid_signature',
      'License key signature is invalid',
    );
  }
  return envelope.payload;
}

export async function signResponseFields(
  fields: Record<string, unknown>,
): Promise<string> {
  const json = JSON.stringify(fields);
  const sig = await signBytes(te.encode(json));
  return bytesToBase64(sig);
}

export class LicenseKeyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const _internal = { hexToBytes, bytesToHex, bytesToBase64, base64ToBytes };
