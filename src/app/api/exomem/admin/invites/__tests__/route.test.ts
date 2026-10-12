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
  mock.module("@/lib/exomem-hosted/invites", {
    namedExports: {
      issueOperatorInvite: async (input: Record<string, unknown>) => {
        issueCalls.push(input);
        if (issueError) throw issueError;
        return { inviteId: "018f2d91-7c42-7000-8000-000000000010", delivery: "queued" };
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
    body: JSON.stringify(
      input.body ?? { email: SENTINEL, kind: "covered", inviterName: "Alex Example" }
    ),
  }) as unknown as import("next/server").NextRequest;
}

describe("POST /api/exomem/admin/invites", () => {
  it("authenticates only the Exomem operator bearer", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ cookie: "endstate_account_session=endstate-only" }));
    assert.equal(response.status, 401);
    assert.equal(issueCalls.length, 0);
  });

  it("creates a valid operator invite and answers that its email is queued", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ authorization: `Bearer ${ADMIN_TOKEN}` }));
    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "queued");
    assert.equal(JSON.stringify(body).includes(SENTINEL), false);
    assert.equal(issueCalls.length, 1);
  });

  it("threads reviewer purpose only from the authenticated operator input", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: {
          email: SENTINEL,
          kind: "covered",
          inviterName: "Alex Example",
          marketplaceReviewerPurpose: true,
        },
      })
    );
    assert.equal(response.status, 201);
    assert.equal(issueCalls[0]?.marketplaceReviewerPurpose, true);
  });

  it("returns content-free issue failures and logs no sentinels", async () => {
    issueError = new ExomemHostedError({
      code: "FRIEND_PRICE_UNAVAILABLE",
      status: 503,
      message: "the friend price cannot be confirmed right now",
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
      assert.match(lines.join("\n"), /FRIEND_PRICE_UNAVAILABLE/);
    } finally {
      setOperationalEventSinkForTests(null);
    }
  });
});
