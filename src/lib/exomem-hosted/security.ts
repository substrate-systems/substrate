import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import { inspect } from "node:util";
import { exomemErrors } from "./errors";

export const EXTERNAL_TOKEN_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ENVELOPE_AAD = Buffer.from("exomem-control-plane:v1", "utf8");
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]+$/;

export type RandomBytesSource = (size: number) => Buffer;

export function generateExternalToken(randomBytes: RandomBytesSource = nodeRandomBytes): string {
  const bytes = randomBytes(EXTERNAL_TOKEN_BYTES);
  if (bytes.length < EXTERNAL_TOKEN_BYTES) {
    throw exomemErrors.encryptedSecretInvalid();
  }
  return Buffer.from(bytes).toString("base64url");
}

export function digestSecret(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

export function tokenDigest(value: string): Buffer | null {
  if (!BASE64URL_TOKEN.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length < EXTERNAL_TOKEN_BYTES) return null;
  } catch {
    return null;
  }
  return digestSecret(value);
}

export function constantTimeSecretEqual(left: string, right: string): boolean {
  return timingSafeEqual(digestSecret(left), digestSecret(right));
}

export class SensitiveSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "SensitiveSecret([REDACTED])";
  }
}

export type SecretEnvelope = {
  version: 1;
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
  tag: string;
};

function decodeControlPlaneKey(encoded: string | undefined): Buffer {
  if (!encoded || !BASE64URL_TOKEN.test(encoded)) {
    throw exomemErrors.controlPlaneKeyInvalid();
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw exomemErrors.controlPlaneKeyInvalid();
  return key;
}

export function controlPlaneKeyFromEnv(): Buffer {
  return decodeControlPlaneKey(process.env.EXOMEM_CONTROL_PLANE_KEY);
}

function requireKey(key?: Buffer): Buffer {
  const resolved = key ?? controlPlaneKeyFromEnv();
  if (resolved.length !== 32) throw exomemErrors.controlPlaneKeyInvalid();
  return resolved;
}

export function encryptSecret(
  value: string | SensitiveSecret,
  options: { key?: Buffer; randomBytes?: RandomBytesSource } = {}
): SecretEnvelope {
  const key = requireKey(options.key);
  const iv = (options.randomBytes ?? nodeRandomBytes)(GCM_IV_BYTES);
  if (iv.length !== GCM_IV_BYTES) throw exomemErrors.encryptedSecretInvalid();
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(ENVELOPE_AAD);
  const plaintext = value instanceof SensitiveSecret ? value.reveal() : value;
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptSecret(
  envelope: SecretEnvelope,
  options: { key?: Buffer } = {}
): SensitiveSecret {
  try {
    if (envelope.version !== 1 || envelope.algorithm !== "A256GCM") {
      throw exomemErrors.encryptedSecretInvalid();
    }
    const key = requireKey(options.key);
    const iv = Buffer.from(envelope.iv, "base64url");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
      throw exomemErrors.encryptedSecretInvalid();
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8"
    );
    return new SensitiveSecret(plaintext);
  } catch {
    throw exomemErrors.encryptedSecretInvalid();
  }
}

export function opaquePrincipalScope(
  input: { product: "exomem"; userId: string; tenantId: string },
  key?: Buffer
): string {
  return createHmac("sha256", requireKey(key))
    .update(`${input.product}\0${input.userId}\0${input.tenantId}`, "utf8")
    .digest("base64url");
}
