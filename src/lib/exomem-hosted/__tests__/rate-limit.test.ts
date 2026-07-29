import assert from "node:assert/strict";
import test from "node:test";
import { EXOMEM_RATE_LIMITS, hashRateLimitKey, normalizedEmailRateLimitKey } from "../rate-limit";

const EMAIL = "owner@example.com";
const FIRST_KEY = Buffer.alloc(32, 0x11);
const SECOND_KEY = Buffer.alloc(32, 0x22);

test("rate-limit identifiers are stable only within one secret and scope", () => {
  const account = EXOMEM_RATE_LIMITS.magicLinkAccount;
  const first = hashRateLimitKey(account, EMAIL, FIRST_KEY);
  assert.equal(first, hashRateLimitKey(account, EMAIL, FIRST_KEY));
  assert.notEqual(first, hashRateLimitKey(account, EMAIL, SECOND_KEY));
  assert.notEqual(first, hashRateLimitKey(EXOMEM_RATE_LIMITS.magicLinkIp, EMAIL, FIRST_KEY));
  assert.equal(first.includes(EMAIL), false);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("operator pre-auth reads, mutations, and authenticated actions have independent buckets", () => {
  const rules = EXOMEM_RATE_LIMITS as Record<string, { scope: string }>;
  assert.notEqual(rules.adminPreAuthReadIp?.scope, rules.adminPreAuthMutationIp?.scope);
  assert.notEqual(rules.adminPreAuthReadIp?.scope, rules.adminAuthenticatedRead?.scope);
  assert.notEqual(rules.adminPreAuthMutationIp?.scope, rules.adminAuthenticatedMutation?.scope);
  assert.notEqual(rules.adminAuthenticatedRead?.scope, rules.adminAuthenticatedMutation?.scope);
});

test("OAuth token exchanges use a dedicated bounded IP rule", () => {
  const rule = EXOMEM_RATE_LIMITS.oauthTokenIp;
  assert.equal(rule.scope, "exomem:oauth-token:ip");
  assert.ok(rule.limit > 0);
  assert.ok(rule.windowSeconds > 0);
});

test("OAuth revocation uses a dedicated bounded IP rule", () => {
  const rule = EXOMEM_RATE_LIMITS.oauthRevokeIp;
  assert.equal(rule.scope, "exomem:oauth-revoke:ip");
  assert.ok(rule.limit > 0);
  assert.ok(rule.windowSeconds > 0);
});

test("invite requests use separate durable IP and normalized-email buckets", () => {
  const ip = EXOMEM_RATE_LIMITS.interestIp;
  const email = EXOMEM_RATE_LIMITS.interestEmail;

  assert.notEqual(ip.scope, email.scope);
  assert.ok(ip.limit > 0);
  assert.ok(ip.windowSeconds > 0);
  assert.ok(email.limit > 0);
  assert.ok(email.windowSeconds > 0);
  assert.equal(normalizedEmailRateLimitKey(" Friend@Example.COM "), "friend@example.com");
  assert.equal(
    hashRateLimitKey(email, normalizedEmailRateLimitKey("Friend@Example.com"), FIRST_KEY),
    hashRateLimitKey(email, normalizedEmailRateLimitKey("friend@example.com"), FIRST_KEY)
  );
});

test("marketplace reviewer authentication uses independent pre-KDF IP and username buckets", () => {
  const ip = EXOMEM_RATE_LIMITS.marketplaceReviewerIp;
  const username = EXOMEM_RATE_LIMITS.marketplaceReviewerUsername;

  assert.notEqual(ip.scope, username.scope);
  assert.ok(ip.limit > 0);
  assert.ok(ip.windowSeconds > 0);
  assert.ok(username.limit > 0);
  assert.ok(username.windowSeconds > 0);
  assert.notEqual(hashRateLimitKey(ip, "203.0.113.1", FIRST_KEY), hashRateLimitKey(username, "reviewer", FIRST_KEY));
});
