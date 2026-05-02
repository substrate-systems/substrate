/**
 * EdDSA (Ed25519) JWT mint and verify, per RFC 8037 / RFC 8032 and the
 * locked claim shape in `hosted-backup-contract.md` §4.
 *
 * Mirrors the env-keyed pattern in `src/lib/license/crypto.ts`: the active
 * private key comes from `ENDSTATE_JWT_PRIVATE_KEY_HEX` (32-byte seed) with
 * `kid` from `ENDSTATE_JWT_ACTIVE_KID`. The `signing_keys` table holds public
 * keys (incl. recently retired) for JWKS publication and verification across
 * rotations.
 */

import { randomUUID } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import type { JwtClaims, SubscriptionStatus } from './types';
import { errors } from './errors';
import {
  getActiveAndRecentlyRetiredSigningKeys,
  type SigningKeyRow,
} from './db';

// Test seam: tests can inject a synthetic keys provider so they don't need a
// real Neon connection. Production calls the DB-backed provider.
type KeysProvider = () => Promise<SigningKeyRow[]>;
let keysProvider: KeysProvider = () => getActiveAndRecentlyRetiredSigningKeys();
export function __setKeysProvider(p: KeysProvider | null): void {
  keysProvider = p ?? (() => getActiveAndRecentlyRetiredSigningKeys());
}

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const te = new TextEncoder();
const td = new TextDecoder();

const ACCESS_TOKEN_TTL_S = 900; // 15 min, contract §4
const RECOVERY_TOKEN_TTL_S = 300; // 5 min, design.md
const ACCESS_AUDIENCE = 'endstate-backup';
const RECOVERY_AUDIENCE = 'endstate-recover';

function getIssuer(): string {
  return process.env.ENDSTATE_OIDC_ISSUER_URL ?? 'https://substratesystems.io';
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

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

let cachedKeyPair: { secretKey: Uint8Array; publicKey: Uint8Array } | null = null;
let cachedFromSecretHex: string | null = null;
let cachedKid: string | null = null;

async function getActiveKeyPair(): Promise<{
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  kid: string;
}> {
  const hex = process.env.ENDSTATE_JWT_PRIVATE_KEY_HEX;
  const kid = process.env.ENDSTATE_JWT_ACTIVE_KID;
  if (!hex) throw new Error('ENDSTATE_JWT_PRIVATE_KEY_HEX is not set');
  if (!kid) throw new Error('ENDSTATE_JWT_ACTIVE_KID is not set');
  if (cachedKeyPair && cachedFromSecretHex === hex && cachedKid === kid) {
    return { ...cachedKeyPair, kid };
  }
  cachedKeyPair = await ed.keygenAsync(hexToBytes(hex));
  cachedFromSecretHex = hex;
  cachedKid = kid;
  return { ...cachedKeyPair, kid };
}

/** Public for the keypair generator script. */
export async function derivePublicKey(privateKeyHex: string): Promise<Uint8Array> {
  const { publicKey } = await ed.keygenAsync(hexToBytes(privateKeyHex));
  return publicKey;
}

type JwtHeader = { alg: 'EdDSA'; typ: 'JWT'; kid: string };

async function signCompactJwt(
  payload: Record<string, unknown>,
): Promise<string> {
  const { secretKey, kid } = await getActiveKeyPair();
  const header: JwtHeader = { alg: 'EdDSA', typ: 'JWT', kid };
  const headerPart = base64url(te.encode(JSON.stringify(header)));
  const payloadPart = base64url(te.encode(JSON.stringify(payload)));
  const signingInput = `${headerPart}.${payloadPart}`;
  const sig = await ed.signAsync(te.encode(signingInput), secretKey);
  return `${signingInput}.${base64url(sig)}`;
}

export async function mintAccessToken(params: {
  userId: string;
  subscriptionStatus: SubscriptionStatus;
}): Promise<{ token: string; jti: string; exp: number; iat: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_S;
  const jti = randomUUID();
  const claims: JwtClaims = {
    iss: getIssuer(),
    sub: params.userId,
    aud: ACCESS_AUDIENCE,
    iat,
    nbf: iat,
    exp,
    jti,
    subscription_status: params.subscriptionStatus,
  };
  const token = await signCompactJwt(claims);
  return { token, jti, exp, iat };
}

export async function mintRecoveryToken(params: {
  userId: string;
}): Promise<{ token: string; exp: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + RECOVERY_TOKEN_TTL_S;
  const claims = {
    iss: getIssuer(),
    sub: params.userId,
    aud: RECOVERY_AUDIENCE,
    iat,
    nbf: iat,
    exp,
    jti: randomUUID(),
  };
  const token = await signCompactJwt(claims);
  return { token, exp };
}

type VerifyOptions = {
  audience?: string;
};

type VerifiedClaims = {
  userId: string;
  subscriptionStatus: SubscriptionStatus;
  jti: string;
  aud: string;
  exp: number;
};

function decodeJsonPart<T>(part: string): T {
  try {
    return JSON.parse(td.decode(fromBase64url(part))) as T;
  } catch {
    throw errors.invalidToken('malformed token segment');
  }
}

/**
 * Verifies a compact JWT against active and recently-retired signing keys.
 * Returns the parsed claims or throws a `HostedBackupError`.
 */
export async function verifyAccessToken(
  token: string,
  opts: VerifyOptions = {},
): Promise<VerifiedClaims> {
  const expectedAud = opts.audience ?? ACCESS_AUDIENCE;
  const parts = token.split('.');
  if (parts.length !== 3) throw errors.invalidToken('not a compact JWT');
  const [headerPart, payloadPart, sigPart] = parts;

  const header = decodeJsonPart<JwtHeader>(headerPart);
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT' || !header.kid) {
    throw errors.invalidToken('unexpected JWT header');
  }

  const keys = await keysProvider();
  const matched = keys.find((k) => k.kid === header.kid);
  if (!matched) throw errors.invalidToken('unknown kid');

  const sig = fromBase64url(sigPart);
  const signingInput = te.encode(`${headerPart}.${payloadPart}`);
  const ok = await ed.verifyAsync(sig, signingInput, matched.public_key);
  if (!ok) throw errors.invalidToken('signature mismatch');

  const claims = decodeJsonPart<JwtClaims>(payloadPart);
  const now = Math.floor(Date.now() / 1000);

  const expectedIss = getIssuer();
  if (claims.iss !== expectedIss) throw errors.invalidToken('wrong issuer');
  if (claims.aud !== expectedAud) throw errors.invalidToken('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp <= now) {
    throw errors.tokenExpired();
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now) {
    throw errors.invalidToken('token not yet valid');
  }
  if (!claims.sub || !claims.jti) {
    throw errors.invalidToken('missing required claims');
  }

  return {
    userId: claims.sub,
    subscriptionStatus:
      (claims.subscription_status as SubscriptionStatus | undefined) ?? 'none',
    jti: claims.jti,
    aud: claims.aud,
    exp: claims.exp,
  };
}

export async function verifyRecoveryToken(token: string): Promise<{ userId: string }> {
  const claims = await verifyAccessToken(token, { audience: RECOVERY_AUDIENCE });
  return { userId: claims.userId };
}

export const _internal = {
  hexToBytes,
  base64url,
  fromBase64url,
  signCompactJwt,
  ACCESS_TOKEN_TTL_S,
  RECOVERY_TOKEN_TTL_S,
  ACCESS_AUDIENCE,
  RECOVERY_AUDIENCE,
};
