import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalMcpArguments, hasMcpSelector, mcpProtocolSupported } from "../mcp";
import { handleHostedMcpRequest } from "../mcp";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import type { ActiveOAuthAccessToken } from "../oauth-store";

const ACCESS: ActiveOAuthAccessToken = {
  familyId: "family",
  grantId: "grant",
  clientId: "client",
  resource: "https://substratesystems.io/api/exomem/mcp/v1",
  scopes: ["exomem.read", "exomem.write"],
  userId: "user",
  tenantId: "tenant",
};

const LIVE = {
  profile: "hosted-alpha-agent-v1" as const,
  endpoint: "https://substratesystems.io/api/exomem/mcp/v1" as const,
  sourceRelease: exomemHostedContractFixture.compatibility.source_release,
  commandFingerprint: exomemHostedContractFixture.compatibility.command_surface_sha256,
  schemaDigest: exomemHostedContractFixture.compatibility.schema_contract_sha256,
  compatibilityDigest: exomemHostedContractFixture.compatibility.compatibility_sha256,
  protocolVersion: exomemHostedContractFixture.compatibility.agent_contract.protocol_version,
  contract: exomemHostedContractFixture.compatibility,
};

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://substratesystems.io/api/exomem/mcp/v1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${"a".repeat(43)}`,
      accept: "application/json, text/event-stream",
      ...headers,
    },
  });
}

describe("Hosted MCP boundary", () => {
  it("rejects recursively supplied routing and authentication selectors", () => {
    for (const value of [
      { tenantId: "other" },
      { nested: { cellId: "other" } },
      { auth: { token: "other" } },
      { session: "other" },
    ]) {
      assert.equal(hasMcpSelector(value), true);
    }
  });

  it("uses stable sorted JSON for mutation retry binding", () => {
    assert.equal(
      canonicalMcpArguments({ b: [2, { z: true, a: false }], a: "value" }),
      canonicalMcpArguments({ a: "value", b: [2, { a: false, z: true }] })
    );
  });

  it("accepts only the application-supported MCP protocol versions", () => {
    assert.equal(mcpProtocolSupported("2025-06-18"), true);
    assert.equal(mcpProtocolSupported("2099-01-01"), false);
  });

  it("negotiates the pinned initialize version and rejects SDK legacy versions", async () => {
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: async () => ACCESS,
      getLiveContract: async () => LIVE,
      takeRateLimit: async () => true,
    };
    const accepted = await handleHostedMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
      dependencies
    );
    assert.equal(accepted.status, 200);
    const rejected = await handleHostedMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
      dependencies
    );
    assert.equal(rejected.status, 400);
  });

  it("serves imported live tools without resolving a cell", async () => {
    let calls = 0;
    const response = await handleHostedMcpRequest(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => ACCESS,
        getLiveContract: async () => LIVE,
        takeRateLimit: async () => true,
        routeCommand: async () => {
          calls += 1;
          throw new Error("discovery must not route");
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(calls, 0);
    const payload = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };
    assert.equal(payload.result?.tools?.length, 13);
    assert.equal(
      payload.result?.tools?.find((tool) => tool.name === "bootstrap")?.name,
      "bootstrap"
    );
  });

  it("returns an OAuth challenge before discovery for a missing bearer", async () => {
    const response = await handleHostedMcpRequest(
      new Request("https://substratesystems.io/api/exomem/mcp/v1", { method: "POST", body: "{}" }),
      { baseUrl: "https://substratesystems.io", takeRateLimit: async () => true }
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata/);
  });
});
