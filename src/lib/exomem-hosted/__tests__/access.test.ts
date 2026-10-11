import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  issueOperatorInvite,
  inspectInvite,
  normalizeAccessEmail,
  redeemMagicLink,
  requestStart,
  type AccessDependencies,
} from "../access";
import { tokenDigest } from "../security";

const SENTINEL = "access-email-token-sentinel@example.com";
const TOKEN = Buffer.alloc(32, 0x61).toString("base64url");
const CHALLENGE = Buffer.alloc(32, 0x62).toString("base64url");

function dependencies(overrides: Partial<AccessDependencies> = {}): AccessDependencies {
  return {
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    randomBytes: (size) => Buffer.alloc(size, 0x61),
    publicBaseUrl: "https://substratesystems.io",
    createInvite: async () => ({ inviteId: "invite-1" }),
    markInviteDelivered: async () => undefined,
    markInviteDeliveryFailed: async () => undefined,
    inspectInvite: async () => ({
      emailNormalized: SENTINEL,
      expiresAt: "2026-07-14T12:00:00.000Z",
    }),
    redeemMagicAccessTokenAtomic: async (input) =>
      input.browserChallengeDigest.equals(tokenDigest(CHALLENGE)!)
        ? {
            userId: "user-1",
            tenantId: "tenant-1",
            sessionId: "session-1",
          }
        : null,
    admissionMode: () => "closed",
    startSelfServe: async () => "admitted",
    createMagicAccessToken: async () => ({ tokenId: "access-1" }),
    encryptDeliverySecret: () => ({
      version: 1,
      algorithm: "A256GCM",
      iv: "delivery-iv",
      ciphertext: "delivery-ciphertext",
      tag: "delivery-tag",
    }),
    sendEmail: async () => ({ success: true, messageId: "message-1" }),
    takeRateLimit: async () => true,
    completeStartRequest: async () => undefined,
    ...overrides,
  };
}

describe("Exomem hosted access", () => {
  it("normalizes and validates bound email addresses", () => {
    assert.equal(normalizeAccessEmail("  PERSON@Example.COM "), "person@example.com");
    assert.throws(() => normalizeAccessEmail("bad\n@example.com"));
  });

  it("stores only an invite digest and emails a fragment token", async () => {
    let dbInput: Record<string, unknown> | undefined;
    let mailInput: Record<string, unknown> | undefined;
    const deps = dependencies({
      createInvite: async (input) => {
        dbInput = input;
        return { inviteId: "invite-1" };
      },
      sendEmail: async (input) => {
        mailInput = input;
        return { success: true, messageId: "message-1" };
      },
    });

    const result = await issueOperatorInvite(
      {
        email: SENTINEL,
        source: "complimentary",
        expiresAt: new Date("2026-07-14T12:00:00.000Z"),
        operatorPrincipalDigest: Buffer.alloc(32, 7),
      },
      deps
    );

    assert.equal(result.inviteId, "invite-1");
    assert.ok(Buffer.isBuffer(dbInput?.tokenDigest));
    assert.equal(JSON.stringify(dbInput).includes("YWFh"), false);
    assert.equal(mailInput?.to, SENTINEL);
    const rendered = `${mailInput?.htmlContent}\n${mailInput?.textContent}`;
    assert.match(rendered, /\/exomem\/invite#[A-Za-z0-9_-]+/);
    assert.doesNotMatch(rendered, /[?&]token=/);
    assert.equal(mailInput?.senderName, "Exomem");
    assert.equal(mailInput?.senderEmail, "exomem@substratesystems.io");
    assert.match(rendered, /Exomem Cloud/);
    assert.doesNotMatch(rendered, /Exomem Hosted/);
  });

  it("passes reviewer purpose only when the authenticated operator explicitly requests it", async () => {
    let dbInput: Record<string, unknown> | undefined;
    await issueOperatorInvite(
      {
        email: SENTINEL,
        source: "complimentary",
        marketplaceReviewerPurpose: true,
        expiresAt: new Date("2026-07-14T12:00:00.000Z"),
        operatorPrincipalDigest: Buffer.alloc(32, 7),
      },
      dependencies({
        createInvite: async (input) => {
          dbInput = input;
          return { inviteId: "invite-1" };
        },
      })
    );
    assert.equal(dbInput?.marketplaceReviewerPurpose, true);
  });

  it("rejects unsafe public origins before sending an invite", async () => {
    let sends = 0;
    await assert.rejects(
      issueOperatorInvite(
        {
          email: SENTINEL,
          source: "complimentary",
          expiresAt: new Date("2026-07-14T12:00:00.000Z"),
          operatorPrincipalDigest: Buffer.alloc(32, 7),
        },
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

  it("allows loopback HTTP only outside production", async () => {
    let rendered = "";
    await issueOperatorInvite(
      {
        email: SENTINEL,
        source: "complimentary",
        expiresAt: new Date("2026-07-14T12:00:00.000Z"),
        operatorPrincipalDigest: Buffer.alloc(32, 7),
      },
      dependencies({
        publicBaseUrl: "http://127.0.0.1:3000",
        sendEmail: async (input) => {
          rendered = input.textContent;
          return { success: true };
        },
      })
    );
    assert.match(rendered, /http:\/\/127\.0\.0\.1:3000\/exomem\/invite#/);
  });

  it("lets only the valid invite holder inspect the email they are about to accept", async () => {
    assert.deepEqual(
      await inspectInvite("YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE", dependencies()),
      {
        email: SENTINEL,
        expiresAt: "2026-07-14T12:00:00.000Z",
      }
    );
    await assert.rejects(
      inspectInvite(
        "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE",
        dependencies({ inspectInvite: async () => null })
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ACCESS_TOKEN_INVALID"
    );
  });

  it("requires the matching browser challenge to redeem a magic link", async () => {
    const deps = dependencies();
    const redeemed = await redeemMagicLink({ token: TOKEN, browserChallenge: CHALLENGE }, deps);
    assert.equal(redeemed.tenantId, "tenant-1");

    await assert.rejects(
      () =>
        redeemMagicLink(
          { token: TOKEN, browserChallenge: Buffer.alloc(32, 0x64).toString("base64url") },
          deps
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ACCESS_TOKEN_INVALID"
    );
  });

  it("maps missing, expired, consumed, and wrong-browser magic links to one failure", async () => {
    const deps = dependencies({
      redeemMagicAccessTokenAtomic: async () => null,
    });
    await assert.rejects(
      () => redeemMagicLink({ token: TOKEN, browserChallenge: "" }, deps),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ACCESS_TOKEN_INVALID"
    );
  });

  it("revokes a failed invite delivery without surfacing provider detail", async () => {
    let failure: { inviteId: string; errorCode: string } | undefined;
    const deps = dependencies({
      sendEmail: async () => ({
        success: false,
        error: "provider leaked credential sentinel",
      }),
      markInviteDeliveryFailed: async (inviteId, errorCode) => {
        failure = { inviteId, errorCode };
      },
    });
    await assert.rejects(
      () =>
        issueOperatorInvite(
          {
            email: SENTINEL,
            source: "complimentary",
            expiresAt: new Date("2026-07-14T12:00:00.000Z"),
            operatorPrincipalDigest: Buffer.alloc(32, 7),
          },
          deps
        ),
      (error: unknown) => {
        assert.equal(String(error).includes("provider leaked"), false);
        return (
          error instanceof Error && "code" in error && error.code === "EMAIL_DELIVERY_UNAVAILABLE"
        );
      }
    );
    assert.deepEqual(failure, {
      inviteId: "invite-1",
      errorCode: "EMAIL_DELIVERY_UNAVAILABLE",
    });
  });

  it("queues an owner's encrypted sign-in link without consulting admission or sending mail", async () => {
    let sends = 0;
    let admissions = 0;
    let createInput: Record<string, unknown> | undefined;
    const deps = dependencies({
      admissionMode: () => "open",
      startSelfServe: async () => {
        admissions += 1;
        return "admitted";
      },
      createMagicAccessToken: async (input) => {
        createInput = input;
        return { tokenId: "access-1", emailNormalized: SENTINEL };
      },
      sendEmail: async () => {
        sends += 1;
        return { success: true, messageId: "message-1" };
      },
    });
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: "Europe/Paris",
      },
      deps
    );
    assert.deepEqual(result, { accepted: true });
    assert.equal(sends, 0);
    assert.equal(admissions, 0);
    assert.deepEqual(createInput?.deliverySecretCiphertext, {
      version: 1,
      algorithm: "A256GCM",
      iv: "delivery-iv",
      ciphertext: "delivery-ciphertext",
      tag: "delivery-tag",
    });
    assert.deepEqual(createInput?.browserChallengeDigest, Buffer.alloc(32, 0x63));
    assert.equal(JSON.stringify(createInput).includes("YWFh"), false);
  });

  it("sends nothing to an address without an Exomem while self-serve is closed", async () => {
    let admissions = 0;
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: null,
      },
      dependencies({
        createMagicAccessToken: async () => null,
        admissionMode: () => "closed",
        startSelfServe: async () => {
          admissions += 1;
          return "admitted";
        },
      })
    );
    assert.deepEqual(result, { accepted: true });
    assert.equal(admissions, 0);
  });

  for (const refused of ["exomem:start:ip", "exomem:start:email"]) {
    it(`stops before any branch when ${refused} refuses, and still pads the answer`, async () => {
      let lookups = 0;
      let padded = 0;
      const result = await requestStart(
        {
          email: SENTINEL,
          networkKey: "blocked-network",
          browserChallengeDigest: Buffer.alloc(32, 0x63),
          timeZone: null,
        },
        dependencies({
          admissionMode: () => "open",
          takeRateLimit: async (rule) => rule.scope !== refused,
          createMagicAccessToken: async () => {
            lookups += 1;
            return null;
          },
          startSelfServe: async () => {
            lookups += 1;
            return "admitted";
          },
          completeStartRequest: async () => {
            padded += 1;
          },
        })
      );
      assert.deepEqual(result, { accepted: true });
      assert.equal(lookups, 0);
      assert.equal(padded, 1);
    });
  }

  it("answers accepted when the self-serve branch fails, so a failure names no branch", async () => {
    let padded = 0;
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: null,
      },
      dependencies({
        createMagicAccessToken: async () => null,
        admissionMode: () => "open",
        startSelfServe: async () => {
          throw new Error("database unavailable");
        },
        completeStartRequest: async () => {
          padded += 1;
        },
      })
    );
    assert.deepEqual(result, { accepted: true });
    assert.equal(padded, 1);
  });
});
