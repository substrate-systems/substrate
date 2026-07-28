import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

type SentEmail = { subject: string; htmlContent: string; textContent: string };
let sent: SentEmail[] = [];
let delivery: { success: boolean; error?: string } | Error = { success: true };
let rateLimitOutcomes: Array<boolean | Error> = [];
let rateLimitCalls: Array<{ scope: string; value: string }> = [];

before(() => {
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: async (message: SentEmail) => {
        if (delivery instanceof Error) throw delivery;
        sent.push(message);
        return delivery;
      },
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: {
        interestIp: { scope: "exomem:interest:ip", limit: 10, windowSeconds: 3600 },
        interestEmail: { scope: "exomem:interest:email", limit: 3, windowSeconds: 86400 },
      },
      clientAddressKey: () => "203.0.113.10",
      normalizedEmailRateLimitKey: (value: string) => value.trim().toLowerCase(),
      takeExomemRateLimit: async (rule: { scope: string }, value: string) => {
        rateLimitCalls.push({ scope: rule.scope, value });
        const outcome = rateLimitOutcomes.shift() ?? true;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  });
});

beforeEach(() => {
  sent = [];
  delivery = { success: true };
  rateLimitOutcomes = [];
  rateLimitCalls = [];
});

function request(body: Record<string, unknown>): import("next/server").NextRequest {
  return new Request("https://substratesystems.io/api/exomem/interest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("POST /api/exomem/interest", () => {
  it("accepts a complimentary private-alpha friends-cohort request", async () => {
    const { POST } = await import("../route");

    const response = await POST(request({ email: "friend@example.com", tier: "complimentary" }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.match(sent[0]?.subject ?? "", /invite request/i);
    assert.match(sent[0]?.textContent ?? "", /complimentary private alpha/i);
  });

  it("returns a content-safe retryable error when delivery is rejected", async () => {
    delivery = { success: false, error: "provider error: secret diagnostic" };
    const { POST } = await import("../route");

    const response = await POST(request({ email: "friend@example.com", tier: "complimentary" }));
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body, { error: "service_unavailable" });
    assert.equal(JSON.stringify(body).includes("secret diagnostic"), false);
  });

  it("returns the same content-safe retryable error when delivery throws", async () => {
    delivery = new Error("provider exception: secret diagnostic");
    const { POST } = await import("../route");

    const response = await POST(request({ email: "friend@example.com" }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  });

  it("denies an exhausted durable IP bucket before calling Brevo", async () => {
    rateLimitOutcomes = [false];
    const { POST } = await import("../route");

    const response = await POST(request({ email: "friend@example.com" }));

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "3600");
    assert.deepEqual(await response.json(), { error: "rate_limited" });
    assert.equal(sent.length, 0);
    assert.deepEqual(rateLimitCalls, [{ scope: "exomem:interest:ip", value: "203.0.113.10" }]);
  });

  it("denies an exhausted normalized-email bucket before calling Brevo", async () => {
    rateLimitOutcomes = [true, false];
    const { POST } = await import("../route");

    const response = await POST(request({ email: "Friend@Example.COM" }));

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "86400");
    assert.deepEqual(await response.json(), { error: "rate_limited" });
    assert.equal(sent.length, 0);
    assert.deepEqual(rateLimitCalls, [
      { scope: "exomem:interest:ip", value: "203.0.113.10" },
      { scope: "exomem:interest:email", value: "friend@example.com" },
    ]);
  });

  it("fails closed before calling Brevo when durable throttling is unavailable", async () => {
    rateLimitOutcomes = [new Error("database unavailable")];
    const { POST } = await import("../route");

    const response = await POST(request({ email: "friend@example.com" }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
    assert.equal(sent.length, 0);
  });

  it("retains input-validation and email-injection defenses", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      request({ email: "friend@example.com\r\nBcc: attacker@example.com" })
    );

    assert.equal(response.status, 400);
    assert.equal(sent.length, 0);
  });
});
