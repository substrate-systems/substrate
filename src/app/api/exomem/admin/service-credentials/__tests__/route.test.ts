import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const ADMIN_TOKEN = Buffer.alloc(32, 0x51).toString("base64url");
const TENANT_ID = "018f2d91-7c42-7000-8000-000000000012";
const CREDENTIAL_ID = "018f2d91-7c42-7000-8000-000000000099";
const SECRET = `exs_${"c".repeat(43)}`;

let issued: Record<string, unknown> | null = null;
let revokeCalls = 0;
let nextRevokeResult = true;
let nextList: unknown[] | null = [];

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
  mock.module("@/lib/exomem-hosted/cloud-service-credentials", {
    namedExports: {
      issueCloudServiceCredentialAtomic: async (input: Record<string, unknown>) => {
        issued = input;
        return {
          credentialId: CREDENTIAL_ID,
          tenantId: TENANT_ID,
          principal: input.principal,
          cellId: "aaaaaaaaaaaaaaaa",
          secret: SECRET,
        };
      },
      listCloudServiceCredentials: async () => nextList,
      revokeCloudServiceCredentialAtomic: async () => {
        revokeCalls += 1;
        return nextRevokeResult;
      },
      // The principal format is not mocked: the route reads the production
      // regex from service-credential-format directly (review R6).
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: {
        adminPreAuthReadIp: { scope: "read-ip", limit: 1, windowSeconds: 60 },
        adminPreAuthMutationIp: { scope: "mutation-ip", limit: 1, windowSeconds: 60 },
        adminAuthenticatedRead: { scope: "read", limit: 1, windowSeconds: 60 },
        adminAuthenticatedMutation: { scope: "mutation", limit: 1, windowSeconds: 60 },
      },
      clientAddressKey: () => "test-ip",
      takeExomemRateLimit: async () => true,
    },
  });
});

after(() => {
  delete process.env.EXOMEM_ADMIN_TOKEN;
  mock.reset();
});

beforeEach(() => {
  issued = null;
  revokeCalls = 0;
  nextRevokeResult = true;
  nextList = [];
});

function request(
  method: string,
  input: { authorization?: string; body?: unknown; query?: string } = {}
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.authorization) headers.set("authorization", input.authorization);
  return new Request(
    `https://substratesystems.io/api/exomem/admin/service-credentials${input.query ?? ""}`,
    {
      method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    }
  ) as unknown as import("next/server").NextRequest;
}

describe("Exomem operator service credentials", () => {
  it("requires the operator bearer on every method", async () => {
    const { DELETE, GET, POST } = await import("../route");
    assert.equal((await GET(request("GET", { query: `?tenantId=${TENANT_ID}` }))).status, 401);
    assert.equal(
      (await POST(request("POST", { body: { tenantId: TENANT_ID } }))).status,
      401
    );
    assert.equal(
      (await DELETE(request("DELETE", { body: { credentialId: CREDENTIAL_ID } }))).status,
      401
    );
  });

  it("issues a credential and returns its secret only in that response", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request("POST", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: { tenantId: TENANT_ID, principal: "service:creator-platform" },
      })
    );
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.secret, SECRET);
    assert.equal(body.credentialId, CREDENTIAL_ID);
    assert.equal(body.principal, "service:creator-platform");
    assert.equal(body.tenantId, TENANT_ID);
    assert.equal(body.cellId, "aaaaaaaaaaaaaaaa");
    assert.equal(issued?.tenantId, TENANT_ID);
    assert.equal(issued?.principal, "service:creator-platform");
  });

  it("enforces the service:<name> principal format", async () => {
    const { POST } = await import("../route");
    for (const principal of [
      "creator-platform",
      "service:",
      "service:Upper",
      "service:bad_name",
      `service:${"a".repeat(41)}`,
      7,
    ]) {
      const response = await POST(
        request("POST", {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          body: { tenantId: TENANT_ID, principal },
        })
      );
      assert.equal(response.status, 400, JSON.stringify(principal));
      assert.equal(issued, null);
      assert.equal((await response.text()).includes(SECRET), false);
    }
  });

  it("requires exactly one tenant selector", async () => {
    const { POST } = await import("../route");
    for (const body of [
      { principal: "service:creator-platform" },
      { tenantId: TENANT_ID, email: "owner@example.test", principal: "service:creator-platform" },
      { tenantId: "not-a-uuid", principal: "service:creator-platform" },
    ]) {
      const response = await POST(
        request("POST", { authorization: `Bearer ${ADMIN_TOKEN}`, body })
      );
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(issued, null);
  });

  it("lists credentials with no secret and no digest", async () => {
    nextList = [
      {
        credentialId: CREDENTIAL_ID,
        principal: "service:creator-platform",
        createdAt: "2026-08-01T00:00:00.000Z",
        revokedAt: null,
      },
    ];
    const { GET } = await import("../route");
    const response = await GET(
      request("GET", { authorization: `Bearer ${ADMIN_TOKEN}`, query: `?tenantId=${TENANT_ID}` })
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(SECRET), false);
    assert.equal(body.includes("digest"), false);
    const parsed = JSON.parse(body) as { credentials: unknown[]; success: boolean };
    assert.equal(parsed.success, true);
    assert.equal(parsed.credentials.length, 1);
  });

  it("revokes idempotently", async () => {
    const { DELETE } = await import("../route");
    const first = await DELETE(
      request("DELETE", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: { credentialId: CREDENTIAL_ID },
      })
    );
    assert.equal(first.status, 200);
    assert.equal((await first.json()).revoked, true);

    nextRevokeResult = false;
    const second = await DELETE(
      request("DELETE", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: { credentialId: CREDENTIAL_ID },
      })
    );
    assert.equal(second.status, 200);
    assert.equal((await second.json()).revoked, false);
    assert.equal(revokeCalls, 2);
  });
});
