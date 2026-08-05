import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateMarketplaceReviewerCredential,
  generateMarketplaceReviewerCredential,
  hashMarketplaceReviewerPassword,
  marketplaceReviewerAccessEnabled,
  normalizeMarketplaceReviewerUsername,
  reviewerUsernameDigest,
  validateMarketplaceReviewerExpiry,
  verifyMarketplaceReviewerPassword,
} from "../reviewer-access";

// Authentication rejects an expired credential, so a literal expiry turns this
// test from a pass into an assertion on `undefined` the day it elapses.
const EXPIRES_AT = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

test("reviewer credentials use opaque generated entropy and do not expose storage values", async () => {
  let sequence = 0;
  const credential = generateMarketplaceReviewerCredential({
    randomBytes: (size) => Buffer.alloc(size, ++sequence),
  });

  assert.match(credential.username, /^exr_[A-Za-z0-9_-]{43}$/);
  assert.match(credential.password, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(credential.username, credential.password);
  assert.equal(credential.usernameDigest.length, 32);
  assert.equal("passwordHash" in credential, false);
});

test("reviewer usernames normalize before their SHA-256 lookup digest", () => {
  assert.equal(normalizeMarketplaceReviewerUsername(" ExR_ABC "), "exr_abc");
  assert.deepEqual(reviewerUsernameDigest(" ExR_ABC "), reviewerUsernameDigest("exr_abc"));
});

test("reviewer passwords are stored as bounded Argon2id hashes", async () => {
  const hash = await hashMarketplaceReviewerPassword("reviewer-password");
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyMarketplaceReviewerPassword(hash, "reviewer-password"), true);
  assert.equal(await verifyMarketplaceReviewerPassword(hash, "incorrect-password"), false);
});

test("reviewer authentication performs dummy verification for unknown usernames", async () => {
  const calls: Array<Buffer> = [];
  const result = await authenticateMarketplaceReviewerCredential(
    { username: "missing", password: "incorrect", clientAddress: "203.0.113.1" },
    {
      enabled: true,
      takeRateLimit: async () => true,
      lookup: async (digest) => {
        calls.push(digest);
        return null;
      },
    }
  );

  assert.equal(result, null);
  assert.equal(calls.length, 1);
});

test("reviewer authentication defaults off and fails closed when either pre-KDF limiter is unavailable", async () => {
  let lookups = 0;
  const dependencies = {
    lookup: async () => {
      lookups += 1;
      return null;
    },
    takeRateLimit: async () => {
      throw new Error("durable limiter unavailable");
    },
  };

  assert.equal(
    await authenticateMarketplaceReviewerCredential(
      { username: "user", password: "password", clientAddress: "203.0.113.1" },
      { ...dependencies, enabled: false }
    ),
    null
  );
  assert.equal(lookups, 0);
  assert.equal(
    await authenticateMarketplaceReviewerCredential(
      { username: "user", password: "password", clientAddress: "203.0.113.1" },
      { ...dependencies, enabled: true }
    ),
    null
  );
  assert.equal(lookups, 0);
  assert.equal(marketplaceReviewerAccessEnabled({}), false);
  assert.equal(
    marketplaceReviewerAccessEnabled({ EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED: "true" }),
    true
  );
});

test("reviewer credential expiry must be a bounded future instant", () => {
  const now = new Date("2026-07-29T00:00:00.000Z");
  assert.throws(() => validateMarketplaceReviewerExpiry(new Date("2026-07-28T23:59:59.000Z"), now));
  assert.throws(() => validateMarketplaceReviewerExpiry(new Date("2026-10-28T00:00:00.001Z"), now));
  assert.doesNotThrow(() =>
    validateMarketplaceReviewerExpiry(new Date("2026-08-28T00:00:00.000Z"), now)
  );
});

test("successful reviewer authentication retains the credential expiry for derived session capping", async () => {
  const passwordHash = await hashMarketplaceReviewerPassword("reviewer-password");
  const authenticated = await authenticateMarketplaceReviewerCredential(
    { username: "reviewer", password: "reviewer-password", clientAddress: "203.0.113.1" },
    {
      enabled: true,
      takeRateLimit: async () => true,
      lookup: async () => ({
        credentialId: "credential-1",
        provider: "openai",
        ownerUserId: "owner-1",
        tenantId: "tenant-1",
        fixtureVersion: "review-fixture-v1",
        passwordHash,
        expiresAt: EXPIRES_AT,
        revokedAt: null,
      }),
    }
  );
  assert.equal(
    (authenticated as { expiresAt?: string } | null)?.expiresAt,
    EXPIRES_AT
  );
});
