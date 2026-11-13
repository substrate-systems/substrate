import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeAccessEmail,
  redeemMagicLink,
  requestStart,
  type AccessDependencies,
} from "../access";
import { tokenDigest } from "../security";
import { selfServeAdmissionMode } from "../self-serve-admission";

const SENTINEL = "access-email-token-sentinel@example.com";
const TOKEN = Buffer.alloc(32, 0x61).toString("base64url");
const CHALLENGE = Buffer.alloc(32, 0x62).toString("base64url");

function dependencies(overrides: Partial<AccessDependencies> = {}): AccessDependencies {
  return {
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    randomBytes: (size) => Buffer.alloc(size, 0x61),
    redeemMagicAccessTokenAtomic: async (input) =>
      input.expectedEmailNormalized === "person@example.com" ||
      (!input.expectedEmailNormalized &&
        input.browserChallengeDigest?.equals(tokenDigest(CHALLENGE)!))
        ? {
            userId: "user-1",
            tenantId: "tenant-1",
            sessionId: "session-1",
            browserChallengeMatched:
              input.browserChallengeDigest?.equals(tokenDigest(CHALLENGE)!) ?? false,
          }
        : null,
    admissionMode: () => "waitlist",
    startSelfServe: async () => ({ outcome: "admitted", emailId: null }),
    dispatchQueuedEmails: async () => undefined,
    createMagicAccessToken: async () => ({ tokenId: "access-1", deliveryId: "delivery-1" }),
    encryptDeliverySecret: () => ({
      version: 1,
      algorithm: "A256GCM",
      iv: "delivery-iv",
      ciphertext: "delivery-ciphertext",
      tag: "delivery-tag",
    }),
    takeRateLimit: async () => true,
    completeStartRequest: async () => undefined,
    afterResponse: (work) => work(),
    ...overrides,
  };
}

describe("Exomem hosted access", () => {
  it("waitlists new people when admission is absent, retired or misspelled", () => {
    assert.equal(selfServeAdmissionMode(""), "waitlist");
    assert.equal(selfServeAdmissionMode("closed"), "waitlist");
    assert.equal(selfServeAdmissionMode("opne"), "waitlist");
    assert.equal(selfServeAdmissionMode("waitlist"), "waitlist");
    assert.equal(selfServeAdmissionMode("open"), "open");
  });
  it("normalizes and validates bound email addresses", () => {
    assert.equal(normalizeAccessEmail("  PERSON@Example.COM "), "person@example.com");
    assert.throws(() => normalizeAccessEmail("bad\n@example.com"));
  });

  it("keeps the matching browser challenge fast path", async () => {
    const deps = dependencies();
    const redeemed = await redeemMagicLink({ token: TOKEN, browserChallenge: CHALLENGE }, deps);
    assert.equal(redeemed.tenantId, "tenant-1");
    assert.equal(redeemed.browserChallengeMatched, true);

    await assert.rejects(
      () =>
        redeemMagicLink(
          { token: TOKEN, browserChallenge: Buffer.alloc(32, 0x64).toString("base64url") },
          deps
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EMAIL_CONFIRMATION_REQUIRED"
    );
  });

  it("asks for email without revealing whether a well-formed link is usable", async () => {
    const deps = dependencies({
      redeemMagicAccessTokenAtomic: async () => null,
    });
    await assert.rejects(
      () => redeemMagicLink({ token: TOKEN, browserChallenge: CHALLENGE }, deps),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EMAIL_CONFIRMATION_REQUIRED"
    );
  });

  it("normalizes expected email and authenticates without the requesting browser", async () => {
    const redeemed = await redeemMagicLink(
      { token: TOKEN, expectedEmail: "  PERSON@EXAMPLE.COM " },
      dependencies()
    );
    assert.equal(redeemed.tenantId, "tenant-1");
    assert.equal(redeemed.browserChallengeMatched, false);
  });

  it("checks a supplied email even when the challenge matches", async () => {
    await assert.rejects(
      () =>
        redeemMagicLink(
          { token: TOKEN, browserChallenge: CHALLENGE, expectedEmail: "other@example.com" },
          dependencies()
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ACCESS_TOKEN_INVALID"
    );
  });

  it("queues an owner's encrypted sign-in link without consulting admission or sending mail", async () => {
    let admissions = 0;
    let createInput: Record<string, unknown> | undefined;
    const deps = dependencies({
      admissionMode: () => "open",
      startSelfServe: async () => {
        admissions += 1;
        return { outcome: "admitted", emailId: null };
      },
      createMagicAccessToken: async (input) => {
        createInput = input;
        return { tokenId: "access-1", deliveryId: "delivery-1", emailNormalized: SENTINEL };
      },
    });
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: "Europe/Paris",
        emailScheme: null,
      },
      deps
    );
    assert.deepEqual(result, { accepted: true, deliveryId: "delivery-1" });
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

  it("queues an address without an Exomem in the default waitlist mode", async () => {
    let admissions = 0;
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: null,
        emailScheme: null,
      },
      dependencies({
        createMagicAccessToken: async () => null,
        admissionMode: () => "waitlist",
        startSelfServe: async () => {
          admissions += 1;
          return { outcome: "admitted", emailId: null };
        },
      })
    );
    assert.deepEqual(result, { accepted: true });
    assert.equal(admissions, 1);
  });

  // The self-serve branch waits on the Cloud capacity lock and the owner
  // branch does not, so a branch run before the answer would time it apart.
  it("answers before the self-serve branch runs, and runs it once the answer is sent", async () => {
    let admissions = 0;
    const deferred: Array<() => Promise<void>> = [];
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: null,
        emailScheme: null,
      },
      dependencies({
        createMagicAccessToken: async () => null,
        admissionMode: () => "open",
        startSelfServe: async () => {
          admissions += 1;
          return { outcome: "admitted", emailId: null };
        },
        afterResponse: async (work) => {
          deferred.push(work);
        },
      })
    );
    assert.deepEqual(result, { accepted: true });
    assert.equal(admissions, 0);
    for (const work of deferred) await work();
    assert.equal(admissions, 1);
  });

  const limitNamedFor = {
    "exomem:start:ip": "ip",
    "exomem:start:browser": "browser",
    "exomem:start:email": "address",
  } as const;
  for (const refused of Object.keys(limitNamedFor) as Array<keyof typeof limitNamedFor>) {
    it(`stops before any branch when ${refused} refuses, and still pads the answer`, async () => {
      let lookups = 0;
      let padded = 0;
      const result = await requestStart(
        {
          email: SENTINEL,
          networkKey: "blocked-network",
          browserKey: "returning-browser",
          browserChallengeDigest: Buffer.alloc(32, 0x63),
          timeZone: null,
          emailScheme: null,
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
            return { outcome: "admitted", emailId: null };
          },
          completeStartRequest: async () => {
            padded += 1;
          },
        })
      );
      // The refusing limit is named, so the page says that nothing was sent; it names no
      // address or network.
      assert.deepEqual(result, { accepted: true, limitedBy: limitNamedFor[refused] });
      assert.equal(lookups, 0);
      assert.equal(padded, 1);
    });
  }

  // The outbox row is committed by startSelfServe; without this call it would
  // wait for the minute delivery job, which was the silent gap.
  it("sends the row the self-serve branch queued, and keeps a failed send out of the answer", async () => {
    const sent: string[][] = [];
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: null,
        emailScheme: null,
        requestId: "request-1",
      },
      dependencies({
        createMagicAccessToken: async () => null,
        admissionMode: () => "open",
        startSelfServe: async () => ({ outcome: "waitlisted", emailId: "email-1" }),
        dispatchQueuedEmails: async (ids, options) => {
          sent.push([...ids, String(options.requestId)]);
          throw new Error("provider unavailable");
        },
      })
    );
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(sent, [["email-1", "request-1"]]);
  });

  it("answers accepted when the self-serve branch fails, so a failure names no branch", async () => {
    let padded = 0;
    const result = await requestStart(
      {
        email: SENTINEL,
        networkKey: "ip-hash-input",
        browserChallengeDigest: Buffer.alloc(32, 0x63),
        timeZone: null,
        emailScheme: null,
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
