import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  issueOperatorInvite,
  normalizeAccessEmail,
  redeemInvite,
  redeemMagicLink,
  requestMagicLink,
  type AccessDependencies,
} from "../access";

const SENTINEL = "access-email-token-sentinel@example.com";

function dependencies(overrides: Partial<AccessDependencies> = {}): AccessDependencies {
  return {
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    randomBytes: (size) => Buffer.alloc(size, 0x61),
    publicBaseUrl: "https://substratesystems.io",
    createInvite: async () => ({ inviteId: "invite-1" }),
    markInviteDelivered: async () => undefined,
    markInviteDeliveryFailed: async () => undefined,
    redeemInviteAtomic: async () => ({
      userId: "user-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
      operationId: "operation-1",
    }),
    redeemMagicAccessTokenAtomic: async () => ({
      userId: "user-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
    }),
    createMagicAccessToken: async () => ({ tokenId: "access-1" }),
    markAccessTokenDelivered: async () => undefined,
    markAccessTokenDeliveryFailed: async () => undefined,
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

  it("rejects replay with one non-enumerating stable failure", async () => {
    const deps = dependencies({ redeemInviteAtomic: async () => null });
    await assert.rejects(
      () => redeemInvite("YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE", deps),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ACCESS_TOKEN_INVALID"
    );
  });

  it("maps expired or consumed magic-link tokens to the same access failure", async () => {
    const deps = dependencies({
      redeemMagicAccessTokenAtomic: async () => null,
    });
    await assert.rejects(
      () => redeemMagicLink("YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE", deps),
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
    const result = await requestMagicLink(SENTINEL, "ip-hash-input", deps);
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
    assert.deepEqual(await requestMagicLink(SENTINEL, "ip-hash-input", deps), { accepted: true });
    assert.equal(creates, 0);
  });

  it("emails an existing owner without exposing account state in its result", async () => {
    let sends = 0;
    const deps = dependencies({
      createMagicAccessToken: async () => ({
        tokenId: "access-1",
        emailNormalized: SENTINEL,
      }),
      sendEmail: async () => {
        sends += 1;
        return { success: true, messageId: "message-1" };
      },
    });
    const result = await requestMagicLink(SENTINEL, "ip-hash-input", deps);
    assert.deepEqual(result, { accepted: true });
    assert.equal(sends, 1);
    assert.equal("known" in result, false);
  });
});
