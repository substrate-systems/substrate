import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { drainMagicLinkDeliveries, type MagicLinkDeliveryDependencies } from "../access-delivery";
import { decryptSecret, encryptSecret, tokenDigest } from "../security";

const KEY = Buffer.alloc(32, 0x44);
const TOKEN = Buffer.alloc(32, 0x61).toString("base64url");
const EMAIL = "owner@example.com";
const EXPIRES = "2026-07-12T12:15:00.000Z";

function record() {
  return {
    deliveryId: "delivery-1",
    tokenId: "token-1",
    emailNormalized: EMAIL,
    expiresAt: EXPIRES,
    tokenDigest: tokenDigest(TOKEN)!,
    secretCiphertext: encryptSecret(
      JSON.stringify({
        version: 1,
        purpose: "magic_link",
        emailNormalized: EMAIL,
        token: TOKEN,
        expiresAt: EXPIRES,
      }),
      { key: KEY, randomBytes: () => Buffer.alloc(12, 0x22) }
    ),
    attempts: 1,
  };
}

function dependencies(
  overrides: Partial<MagicLinkDeliveryDependencies> = {}
): MagicLinkDeliveryDependencies {
  let next = record();
  return {
    now: () => new Date("2026-07-12T12:01:00.000Z"),
    newLeaseOwner: () => "11111111-1111-4111-8111-111111111111",
    publicBaseUrl: "https://substratesystems.io",
    pruneRateLimits: async () => 2,
    expireInvalid: async () => 0,
    claim: async () => {
      const claimed = next;
      next = null as never;
      return claimed;
    },
    markSent: async () => true,
    release: async () => "retry",
    decrypt: (envelope) => decryptSecret(envelope, { key: KEY }),
    sendEmail: async () => ({ success: true, messageId: "message-1" }),
    ...overrides,
  };
}

describe("durable Exomem magic-link delivery", () => {
  it("decrypts a row-bound single-use token only in the leased worker", async () => {
    let email: Record<string, unknown> | undefined;
    let marked: Record<string, unknown> | undefined;
    const result = await drainMagicLinkDeliveries(
      { maxMessages: 1 },
      dependencies({
        sendEmail: async (input) => {
          email = input;
          return { success: true, messageId: "message-1" };
        },
        markSent: async (input) => {
          marked = input;
          return true;
        },
      })
    );

    assert.deepEqual(result, {
      expired: 0,
      prunedRateLimits: 2,
      claimed: 1,
      sent: 1,
      retryScheduled: 0,
      failed: 0,
      lost: 0,
    });
    assert.equal(email?.to, EMAIL);
    assert.equal(email?.senderEmail, "exomem@substratesystems.io");
    assert.match(String(email?.textContent), /\/exomem\/sign-in#[A-Za-z0-9_-]+/);
    assert.doesNotMatch(String(email?.textContent), /[?&]token=/);
    assert.deepEqual(marked, {
      deliveryId: "delivery-1",
      leaseOwner: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("prunes stale limiter buckets before claiming access delivery", async () => {
    const calls: string[] = [];
    await drainMagicLinkDeliveries(
      { maxMessages: 1 },
      dependencies({
        pruneRateLimits: async (retentionSeconds, limit) => {
          calls.push(`prune:${retentionSeconds}:${limit}`);
          return 3;
        },
        expireInvalid: async () => {
          calls.push("expire");
          return 0;
        },
        claim: async () => null,
      })
    );
    assert.match(calls[0] ?? "", /^prune:\d+:1000$/);
    assert.equal(calls[1], "expire");
  });

  it("rejects an unsafe public origin before sending a magic link", async () => {
    let sends = 0;
    await assert.rejects(
      drainMagicLinkDeliveries(
        { maxMessages: 1 },
        dependencies({
          publicBaseUrl: "http://attacker.example",
          sendEmail: async () => {
            sends += 1;
            return { success: true };
          },
        })
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "PUBLIC_BASE_URL_INVALID"
    );
    assert.equal(sends, 0);
  });

  it("fails a swapped or corrupt encrypted payload without sending", async () => {
    let sends = 0;
    let release: Record<string, unknown> | undefined;
    const bad = record();
    bad.emailNormalized = "different-owner@example.com";
    const result = await drainMagicLinkDeliveries(
      { maxMessages: 1 },
      dependencies({
        claim: async () => bad,
        sendEmail: async () => {
          sends += 1;
          return { success: true };
        },
        release: async (input) => {
          release = input;
          return "failed";
        },
      })
    );

    assert.equal(sends, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(release, {
      deliveryId: "delivery-1",
      leaseOwner: "11111111-1111-4111-8111-111111111111",
      errorCode: "DELIVERY_PAYLOAD_INVALID",
      terminal: true,
    });
  });

  it("releases a provider failure for bounded retry without exposing its detail", async () => {
    let released: Record<string, unknown> | undefined;
    const result = await drainMagicLinkDeliveries(
      { maxMessages: 1 },
      dependencies({
        sendEmail: async () => ({ success: false, error: "recipient-private-sentinel" }),
        release: async (input) => {
          released = input;
          return "retry";
        },
      })
    );
    assert.equal(result.retryScheduled, 1);
    assert.deepEqual(released, {
      deliveryId: "delivery-1",
      leaseOwner: "11111111-1111-4111-8111-111111111111",
      errorCode: "EMAIL_DELIVERY_UNAVAILABLE",
      terminal: false,
    });
  });
});
