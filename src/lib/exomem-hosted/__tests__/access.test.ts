import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  issueOperatorInvite,
  inspectInvite,
  normalizeAccessEmail,
  redeemInvite,
  redeemMagicLink,
  requestMagicLink,
  requestSelfServeAccess,
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
    redeemInviteAtomic: async () => ({
      userId: "user-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
      operationId: "operation-1",
    }),
    redeemMagicAccessTokenAtomic: async (input) =>
      input.browserChallengeDigest.equals(tokenDigest(CHALLENGE)!)
        ? {
            userId: "user-1",
            tenantId: "tenant-1",
            sessionId: "session-1",
          }
        : null,
    admitSelfServeOrWaitlist: async () => ({
      outcome: "admitted" as const,
      inviteId: "invite-1",
    }),
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
    completeMagicLinkRequest: async () => undefined,
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

  it("rejects replay with one non-enumerating stable failure", async () => {
    const deps = dependencies({ redeemInviteAtomic: async () => null });
    await assert.rejects(
      () => redeemInvite("YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE", deps),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ACCESS_TOKEN_INVALID"
    );
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

  it("never creates or emails for an unknown magic-link address", async () => {
    let sends = 0;
    const deps = dependencies({
      createMagicAccessToken: async () => null,
      sendEmail: async () => {
        sends += 1;
        return { success: true };
      },
    });
    const result = await requestMagicLink(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
      },
      deps
    );
    assert.deepEqual(result, { accepted: true });
    assert.equal(sends, 0);
  });

  it("returns the same acknowledgement when rate limited", async () => {
    let creates = 0;
    const deps = dependencies({
      takeRateLimit: async () => false,
      createMagicAccessToken: async () => {
        creates += 1;
        return { tokenId: "unexpected" };
      },
    });
    assert.deepEqual(
      await requestMagicLink(
        {
          email: SENTINEL,
          networkKey: "ip-hash-input",
          browserChallengeDigest: Buffer.alloc(32, 0x63),
        },
        deps
      ),
      { accepted: true }
    );
    assert.equal(creates, 0);
  });

  it("checks the network bucket before account-derived storage and short-circuits", async () => {
    const scopes: string[] = [];
    let creates = 0;
    const deps = dependencies({
      takeRateLimit: async (rule) => {
        scopes.push(rule.scope);
        return false;
      },
      createMagicAccessToken: async () => {
        creates += 1;
        return { tokenId: "unexpected" };
      },
    });
    assert.deepEqual(
      await requestMagicLink(
        {
          email: SENTINEL,
          networkKey: "blocked-network",
          browserChallengeDigest: Buffer.alloc(32, 0x63),
        },
        deps
      ),
      { accepted: true }
    );
    assert.deepEqual(scopes, ["exomem:magic-link:ip"]);
    assert.equal(creates, 0);
  });

  it("atomically queues an existing owner's encrypted link without waiting on email", async () => {
    let sends = 0;
    let createInput: Record<string, unknown> | undefined;
    const deps = dependencies({
      createMagicAccessToken: async (input) => {
        createInput = input;
        return {
          tokenId: "access-1",
          emailNormalized: SENTINEL,
        };
      },
      sendEmail: async () => {
        sends += 1;
        return { success: true, messageId: "message-1" };
      },
    });
    const result = await requestMagicLink(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
      },
      deps
    );
    assert.deepEqual(result, { accepted: true });
    assert.equal(sends, 0);
    assert.equal("known" in result, false);
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
});

describe("Exomem hosted self-serve admission", () => {
  it("admits a visitor when the pool has room and emails them a setup link", async () => {
    const sent: Array<{ to: string; subject: string; textContent: string }> = [];
    let delivered: string | null = null;
    let admissionInput: { expiresAt: Date; emailNormalized: string } | null = null;
    const result = await requestSelfServeAccess(
      { email: SENTINEL, networkKey: "ip-hash-input" },
      dependencies({
        admitSelfServeOrWaitlist: async (input) => {
          admissionInput = input;
          return { outcome: "admitted", inviteId: "invite-7" };
        },
        sendEmail: async (input) => {
          sent.push({
            to: input.to,
            subject: input.subject,
            textContent: input.textContent ?? "",
          });
          return { success: true, messageId: "message-1" };
        },
        markInviteDelivered: async (inviteId) => {
          delivered = inviteId;
        },
      })
    );

    assert.deepEqual(result, { outcome: "admitted" });
    assert.equal(delivered, "invite-7");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, SENTINEL);
    assert.equal(sent[0].subject, "Set up your Exomem");
    // The token must reach the visitor as a URL fragment, never a query string:
    // fragments are not sent to the server and do not land in access logs.
    assert.match(sent[0].textContent, /https:\/\/substratesystems\.io\/exomem\/invite#/);
    // A self-serve invite holds a place against the pool, so it must expire in
    // days rather than the operator invite's month-long ceiling.
    assert.equal(admissionInput!.emailNormalized, SENTINEL);
    assert.equal(
      admissionInput!.expiresAt.toISOString(),
      new Date("2026-07-19T12:00:00.000Z").toISOString()
    );
  });

  it("waitlists plainly when the pool is full, and mints no invite", async () => {
    const sent: string[] = [];
    let delivered = 0;
    const result = await requestSelfServeAccess(
      { email: SENTINEL, networkKey: "ip-hash-input" },
      dependencies({
        admitSelfServeOrWaitlist: async () => ({ outcome: "waitlisted", position: 4 }),
        sendEmail: async (input) => {
          sent.push(input.textContent ?? "");
          return { success: true, messageId: "message-1" };
        },
        markInviteDelivered: async () => {
          delivered += 1;
        },
      })
    );

    assert.deepEqual(result, { outcome: "waitlisted", position: 4 });
    assert.equal(delivered, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /number 4 in line/);
    // The waitlist must never read as a charge or as a rejection.
    assert.match(sent[0], /You have not been charged/);
    assert.equal(/set up|checkout|pay/i.test(sent[0].split("open source")[0]), false);
  });

  it("keeps the visitor waitlisted even when the courtesy email fails", async () => {
    const result = await requestSelfServeAccess(
      { email: SENTINEL, networkKey: "ip-hash-input" },
      dependencies({
        admitSelfServeOrWaitlist: async () => ({ outcome: "waitlisted", position: 1 }),
        sendEmail: async () => {
          throw new Error("brevo unavailable");
        },
      })
    );
    // The row is already committed. Failing here would tell a queued visitor
    // they were rejected, and a retry would re-queue them.
    assert.deepEqual(result, { outcome: "waitlisted", position: 1 });
  });

  it("revokes the invite when the setup email cannot be delivered", async () => {
    let revoked: { inviteId: string; code: string } | null = null;
    await assert.rejects(
      requestSelfServeAccess(
        { email: SENTINEL, networkKey: "ip-hash-input" },
        dependencies({
          admitSelfServeOrWaitlist: async () => ({ outcome: "admitted", inviteId: "invite-9" }),
          sendEmail: async () => ({ success: false }),
          markInviteDeliveryFailed: async (inviteId, code) => {
            revoked = { inviteId, code };
          },
        })
      )
    );
    // The token existed only in that email. Left outstanding it would hold a
    // place against the pool that nobody can ever consume.
    assert.deepEqual(revoked, {
      inviteId: "invite-9",
      code: "EMAIL_DELIVERY_UNAVAILABLE",
    });
  });

  it("refuses to decide admission for a throttled address", async () => {
    let admissionAttempts = 0;
    await assert.rejects(
      requestSelfServeAccess(
        { email: SENTINEL, networkKey: "ip-hash-input" },
        dependencies({
          takeRateLimit: async (rule) => rule.scope !== "exomem:admission:email",
          admitSelfServeOrWaitlist: async () => {
            admissionAttempts += 1;
            return { outcome: "admitted", inviteId: "invite-1" };
          },
        })
      )
    );
    assert.equal(admissionAttempts, 0);
  });

  it("rejects a malformed address before consuming any rate-limit budget", async () => {
    let rateLimitChecks = 0;
    await assert.rejects(
      requestSelfServeAccess(
        { email: "not-an-email", networkKey: "ip-hash-input" },
        dependencies({
          takeRateLimit: async () => {
            rateLimitChecks += 1;
            return true;
          },
        })
      )
    );
    assert.equal(rateLimitChecks, 0);
  });
});
