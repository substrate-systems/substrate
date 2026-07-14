import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import {
  SensitiveSecret,
  constantTimeSecretEqual,
  decryptSecret,
  digestSecret,
  encryptSecret,
  generateExternalToken,
  opaquePrincipalScope,
  tokenDigest,
} from "../security";
import { safeErrorEnvelope } from "../errors";
import { buildOperationalEvent } from "../observability";

const SENTINEL = "sensitive-email-token-credential-path-query-sentinel";

describe("Exomem hosted secrets", () => {
  it("mints at least 32 random bytes and stores a SHA-256 digest", () => {
    const token = generateExternalToken((size) => Buffer.alloc(size, 0x5a));
    assert.equal(Buffer.from(token, "base64url").length, 32);
    const digest = tokenDigest(token);
    assert.ok(digest);
    assert.equal(digest.length, 32);
    assert.notEqual(digest.toString("utf8"), token);
    assert.deepEqual(digest, digestSecret(token));
  });

  it("compares secrets in constant-time-compatible fixed-length form", () => {
    assert.equal(constantTimeSecretEqual("alpha", "alpha"), true);
    assert.equal(constantTimeSecretEqual("alpha", "alpha-longer"), false);
  });

  it("round-trips AES-256-GCM without serializing plaintext", () => {
    const key = Buffer.alloc(32, 0x31);
    const envelope = encryptSecret(SENTINEL, {
      key,
      randomBytes: (size) => Buffer.alloc(size, 0x22),
    });
    assert.equal(JSON.stringify(envelope).includes(SENTINEL), false);

    const secret = decryptSecret(envelope, { key });
    assert.equal(secret.reveal(), SENTINEL);
    assert.equal(JSON.stringify(secret).includes(SENTINEL), false);
    assert.equal(inspect(secret).includes(SENTINEL), false);
    assert.equal(String(secret).includes(SENTINEL), false);
    assert.ok(secret instanceof SensitiveSecret);
  });

  it("builds opaque principals without embedding identity", () => {
    const key = Buffer.alloc(32, 0x44);
    const first = opaquePrincipalScope(
      { product: "exomem", userId: "user-sentinel", tenantId: "tenant-sentinel" },
      key
    );
    const second = opaquePrincipalScope(
      { product: "exomem", userId: "user-sentinel", tenantId: "tenant-sentinel" },
      key
    );
    assert.equal(first, second);
    assert.equal(first.includes("user-sentinel"), false);
    assert.equal(first.includes("tenant-sentinel"), false);
  });

  it("excludes arbitrary sensitive keys from errors and operational events", () => {
    const envelope = safeErrorEnvelope(new Error(SENTINEL), "req-safe");
    assert.equal(JSON.stringify(envelope).includes(SENTINEL), false);

    const event = buildOperationalEvent({
      event: "access.invite.delivery_failed",
      outcome: "failed",
      requestId: "018f2d91-7c42-7000-8000-000000000001",
      errorCode: "EMAIL_DELIVERY_UNAVAILABLE",
      email: SENTINEL,
      token: SENTINEL,
      credential: SENTINEL,
      path: SENTINEL,
      query: SENTINEL,
      error: SENTINEL,
    });
    assert.equal(JSON.stringify(event).includes(SENTINEL), false);
    assert.deepEqual(Object.keys(event).sort(), [
      "errorCode",
      "event",
      "outcome",
      "requestId",
      "timestamp",
    ]);
  });
});
