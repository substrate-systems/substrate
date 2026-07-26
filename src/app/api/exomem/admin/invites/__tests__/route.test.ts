import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";
import { setOperationalEventSinkForTests } from "@/lib/exomem-hosted/observability";

const ADMIN_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");
const SENTINEL = "operator-email-token-credential-sentinel@example.com";
let issueCalls: Array<Record<string, unknown>> = [];
let issueError: Error | null = null;
let rateAllowed = true;

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
  mock.module("@/lib/exomem-hosted/access", {
    namedExports: {
      issueOperatorInvite: async (input: Record<string, unknown>) => {
        issueCalls.push(input);
        if (issueError) throw issueError;
        return { inviteId: "018f2d91-7c42-7000-8000-000000000010", delivery: "sent" };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: {
        adminPreAuthMutationIp: { scope: "mutation-ip", limit: 1, windowSeconds: 60 },
        adminAuthenticatedMutation: { scope: "mutation", limit: 1, windowSeconds: 60 },
      },
      clientAddressKey: () => "test-ip",
      takeExomemRateLimit: async () => rateAllowed,
    },
  });
});

after(() => {
  delete process.env.EXOMEM_ADMIN_TOKEN;
  mock.reset();
});

beforeEach(() => {
  issueCalls = [];
  issueError = null;
  rateAllowed = true;
});

function request(input: {
  authorization?: string;
  body?: Record<string, unknown>;
  cookie?: string;
}): import("next/server").NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.authorization) headers.set("authorization", input.authorization);
  if (input.cookie) headers.set("cookie", input.cookie);
  return new Request("https://substratesystems.io/api/exomem/admin/invites", {
    method: "POST",
    headers,
    body: JSON.stringify(input.body ?? { email: SENTINEL, source: "complimentary" }),
  }) as unknown as import("next/server").NextRequest;
}

describe("POST /api/exomem/admin/invites", () => {
  it("authenticates only the Exomem operator bearer", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ cookie: "endstate_account_session=endstate-only" }));
    assert.equal(response.status, 401);
    assert.equal(issueCalls.length, 0);
  });

  it("creates and delivers a valid operator invite", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ authorization: `Bearer ${ADMIN_TOKEN}` }));
    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "sent");
    assert.equal(JSON.stringify(body).includes(SENTINEL), false);
    assert.equal(issueCalls.length, 1);
  });

  it("returns content-free delivery failures and logs no sentinels", async () => {
    issueError = new ExomemHostedError({
      code: "EMAIL_DELIVERY_UNAVAILABLE",
      status: 503,
      message: "access email delivery is temporarily unavailable",
      retryable: true,
    });
    const lines: string[] = [];
    setOperationalEventSinkForTests((line) => lines.push(line));
    try {
      const { POST } = await import("../route");
      const response = await POST(request({ authorization: `Bearer ${ADMIN_TOKEN}` }));
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes(SENTINEL), false);
      assert.equal(lines.join("\n").includes(SENTINEL), false);
      assert.match(lines.join("\n"), /EMAIL_DELIVERY_UNAVAILABLE/);
    } finally {
      setOperationalEventSinkForTests(null);
    }
  });
});
