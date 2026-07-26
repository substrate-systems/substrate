import assert from "node:assert/strict";
import test from "node:test";
import { EXOMEM_RATE_LIMITS, hashRateLimitKey } from "../rate-limit";

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

test("operator pre-auth, reads, and mutations have independent bounded buckets", () => {
  const rules = EXOMEM_RATE_LIMITS as Record<string, { scope: string }>;
  assert.notEqual(rules.adminPreAuthIp?.scope, rules.adminAuthenticatedRead?.scope);
  assert.notEqual(rules.adminAuthenticatedRead?.scope, rules.adminAuthenticatedMutation?.scope);
});
