import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { runMarketplacePreflight } from "../../../../scripts/exomem-marketplace-preflight";
import { exomemHostedContractFixture } from "../agent-contract-fixture";

const origin = "https://hosted.example.test";
const json = (value: unknown, contentType = "application/json") =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": contentType } });
const initializeResult = (
  result: Record<string, unknown> = {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "Hosted Exomem", version: exomemHostedContractFixture.sourceRelease },
  }
) => ({
  jsonrpc: "2.0",
  id: 1,
  result,
});
const toolsResult = (tools: unknown, result: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 2,
  result: { ...result, tools },
});
const protectedMetadata = () =>
  json({
    resource: `${origin}/api/exomem/mcp/v1`,
    authorization_servers: [`${origin}/api/exomem/oauth`],
    bearer_methods_supported: ["header"],
    scopes_supported: ["exomem.read", "exomem.write"],
  });
const authorizationMetadata = () =>
  json({
    issuer: `${origin}/api/exomem/oauth`,
    authorization_endpoint: `${origin}/api/exomem/oauth/authorize`,
    token_endpoint: `${origin}/api/exomem/oauth/token`,
    revocation_endpoint: `${origin}/api/exomem/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["exomem.read", "exomem.write", "offline_access"],
  });
const domainChallenge = (challenge: string) =>
  new Response(challenge, {
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
const publicPage = (path: string) => {
  const pages: Record<string, string> = {
    "/exomem": "Hosted private alpha. Tenant cells process plaintext for search.",
    "/exomem/privacy":
      "Substrate Systems OÜ is the controller. Legal basis, retention, and plaintext processing are described.",
    "/exomem/terms": "Substrate Systems OÜ private alpha terms cover export and deletion.",
    "/exomem/support": "Contact founder@substratesystems.io for support.",
    "/exomem/setup": "sign in once. Custom instructions are a fallback.",
  };
  return new Response(pages[path]);
};
type CompleteTool = Record<string, unknown> & {
  name: string;
  description: string;
  _meta: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};
const completeTools = (): CompleteTool[] =>
  exomemHostedContractFixture.compatibility.agent_contract.commands.map((command) => ({
    ...command.mcp_tool,
    _meta: {
      ...command.mcp_tool._meta,
      securitySchemes:
        exomemHostedContractFixture.compatibility.oauth_discovery.tools[command.mcp_tool.name]
          .securitySchemes,
    },
  })) as unknown as CompleteTool[];
const canonicalJson = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])])
  );
};
const contractDigest = (tools: ReturnType<typeof completeTools>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        tools
          .map((tool) => canonicalJson(tool) as Record<string, unknown>)
          .sort((left, right) => String(left.name).localeCompare(String(right.name)))
      )
    )
    .digest("hex");

describe("Exomem marketplace preflight", () => {
  it("emits only statuses and digests for public contract checks", async () => {
    const challenge = "operator-held-domain-proof";
    const evidence = await runMarketplacePreflight({
      origin,
      timeoutMs: 100,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/.well-known/openai-apps-challenge") return domainChallenge(challenge);
        if (path === "/api/exomem/mcp/v1") {
          const requestOrigin = (init?.headers as Record<string, string> | undefined)?.origin;
          if (requestOrigin === "https://attacker.invalid")
            return new Response(null, { status: 403 });
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata=\"${origin}/.well-known/oauth-protected-resource/api/exomem/mcp/v1\"`,
            },
          });
        }
        if (path.includes("oauth-protected-resource")) {
          return protectedMetadata();
        }
        if (path.includes("oauth-authorization-server")) return authorizationMetadata();
        return publicPage(path);
      },
      challenge,
    });

    assert.equal(evidence.ok, true);
    assert.equal(evidence.origin, origin);
    assert.equal(evidence.routes.length, 10);
    assert.deepEqual(evidence.routes.at(-1), {
      path: "/api/exomem/mcp/v1#origin-rejection",
      status: 403,
    });
    assert.equal(JSON.stringify(evidence).includes(challenge), false);
    assert.equal(evidence.challengeDigest, createHash("sha256").update(challenge).digest("hex"));
  });

  it("fails without printing an unexpected response body", async () => {
    await assert.rejects(
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        fetch: async () => new Response("secret response body", { status: 500 }),
      }),
      /PUBLIC_ROUTE_STATUS/
    );
  });

  it("fails safely for redirects and request failures", async () => {
    await assert.rejects(
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
      }),
      /UNEXPECTED_REDIRECT/
    );
    await assert.rejects(
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        fetch: async () => Promise.reject(new Error("network detail")),
      }),
      /ROUTE_REQUEST_FAILURE/
    );
  });

  it("fails on a canonical metadata mismatch", async () => {
    await assert.rejects(
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;
          if (path === "/.well-known/oauth-protected-resource/api/exomem/mcp/v1") {
            return json({ resource: "https://wrong.example.test/api/exomem/mcp/v1" });
          }
          return publicPage(path);
        },
      }),
      /PROTECTED_RESOURCE_METADATA_MISMATCH/
    );
  });

  it("rejects incomplete OAuth metadata and an unsafe domain-proof response", async () => {
    await assert.rejects(
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/.well-known/openai-apps-challenge") {
            return new Response("expected", { headers: { "content-type": "application/json" } });
          }
          if (path === "/api/exomem/mcp/v1") {
            const requestOrigin = new Headers(init?.headers).get("origin");
            if (requestOrigin === "https://attacker.invalid")
              return new Response(null, { status: 403 });
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/exomem/mcp/v1"`,
              },
            });
          }
          if (path.includes("oauth-protected-resource")) return protectedMetadata();
          if (path.includes("oauth-authorization-server")) return authorizationMetadata();
          return publicPage(path);
        },
      }),
      /DOMAIN_CHALLENGE_RESPONSE_MISMATCH/
    );
  });

  it("records only safe tool metadata when a reviewer token is supplied", async () => {
    const evidence = await runMarketplacePreflight({
      origin,
      timeoutMs: 100,
      challenge: "expected",
      reviewerToken: "reviewer-token",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const request = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
        const headers = new Headers(init?.headers);
        const authorization = headers.get("authorization");
        if (path === "/.well-known/openai-apps-challenge") return domainChallenge("expected");
        if (path === "/api/exomem/mcp/v1" && !authorization) {
          const requestOrigin = (init?.headers as Record<string, string> | undefined)?.origin;
          if (requestOrigin === "https://attacker.invalid")
            return new Response(null, { status: 403 });
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/exomem/mcp/v1"`,
            },
          });
        }
        if (path === "/api/exomem/mcp/v1") {
          assert.equal(headers.get("accept"), "application/json, text/event-stream");
          assert.equal(headers.get("content-type"), "application/json");
          if (request.method === "initialize") {
            assert.equal(headers.get("mcp-protocol-version"), null);
            assert.deepEqual(request, {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "exomem-marketplace-preflight", version: "1" },
              },
            });
            return json(initializeResult());
          }
          if (request.method === "tools/list") {
            assert.equal(headers.get("mcp-protocol-version"), "2025-06-18");
            return json(toolsResult(completeTools()));
          }
          assert.fail(`Unexpected MCP method: ${String(request.method)}`);
        }
        if (path.includes("oauth-protected-resource")) return protectedMetadata();
        if (path.includes("oauth-authorization-server")) return authorizationMetadata();
        return publicPage(path);
      },
    });

    assert.deepEqual(
      evidence.authenticated?.toolNames,
      completeTools()
        .map((tool) => tool.name)
        .sort()
    );
    assert.match(evidence.authenticated?.toolContractDigest ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(evidence.routes.at(-1), {
      path: "/api/exomem/mcp/v1#content-minimization",
      status: 200,
      digest: evidence.authenticated?.toolContractDigest,
    });
    assert.equal(JSON.stringify(evidence).includes("reviewer-token"), false);
  });

  it("binds the complete tools contract including OAuth scopes into a stable redacted digest", async () => {
    const run = async (tools: unknown[]) =>
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        reviewerToken: "reviewer-token",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          const headers = new Headers(init?.headers);
          if (path === "/.well-known/openai-apps-challenge") return domainChallenge("expected");
          if (path === "/api/exomem/mcp/v1" && !headers.get("authorization")) {
            return headers.get("origin") === "https://attacker.invalid"
              ? new Response(null, { status: 403 })
              : new Response(null, {
                  status: 401,
                  headers: {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/exomem/mcp/v1"`,
                  },
                });
          }
          const method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
          if (path === "/api/exomem/mcp/v1" && method === "initialize") {
            return json(initializeResult());
          }
          if (path === "/api/exomem/mcp/v1" && method === "tools/list") {
            return json(toolsResult(tools));
          }
          if (path.includes("oauth-protected-resource")) return protectedMetadata();
          if (path.includes("oauth-authorization-server")) return authorizationMetadata();
          return publicPage(path);
        },
      });
    const tools = completeTools();
    const first = await run(tools);
    const reordered = await run([...tools].reverse());
    const incorrectlyScoped = [
      {
        ...tools[0],
        _meta: {
          ...tools[0]._meta,
          securitySchemes: [{ type: "oauth2", scopes: ["exomem.write"] }],
        },
      },
      ...tools.slice(1),
    ];

    assert.equal(
      first.authenticated?.toolContractDigest,
      reordered.authenticated?.toolContractDigest
    );
    assert.equal(first.authenticated?.toolContractDigest, contractDigest(tools));
    await assert.rejects(run(incorrectlyScoped), /MCP_TOOLS_CONTRACT_MISMATCH/);
    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes(tools[0].description), false);
    assert.equal(serialized.includes(JSON.stringify(tools[0].inputSchema)), false);
  });

  it("fails closed for empty, incomplete, malformed, or changed tool descriptors", async () => {
    const run = async (
      tools: unknown,
      response: unknown = toolsResult(tools),
      initialized: unknown = initializeResult(),
      initializeContentType = "application/json",
      toolsContentType = "application/json"
    ) =>
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        reviewerToken: "reviewer-token",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          const headers = new Headers(init?.headers);
          if (path === "/.well-known/openai-apps-challenge") return domainChallenge("expected");
          if (path === "/api/exomem/mcp/v1" && !headers.get("authorization")) {
            return headers.get("origin") === "https://attacker.invalid"
              ? new Response(null, { status: 403 })
              : new Response(null, {
                  status: 401,
                  headers: {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/exomem/mcp/v1"`,
                  },
                });
          }
          const method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
          if (path === "/api/exomem/mcp/v1" && method === "initialize") {
            return json(initialized, initializeContentType);
          }
          if (path === "/api/exomem/mcp/v1" && method === "tools/list") {
            return json(response, toolsContentType);
          }
          if (path.includes("oauth-protected-resource")) return protectedMetadata();
          if (path.includes("oauth-authorization-server")) return authorizationMetadata();
          return publicPage(path);
        },
      });

    await assert.rejects(run([]), /MCP_TOOLS_CONTRACT_INVALID/);
    await assert.rejects(run(completeTools().slice(1)), /MCP_TOOLS_CONTRACT_MISMATCH/);
    await assert.rejects(run([{ name: "bootstrap" }]), /MCP_TOOLS_CONTRACT_INVALID/);
    const incorrectlyScoped = completeTools();
    incorrectlyScoped[0] = {
      ...incorrectlyScoped[0],
      _meta: {
        ...incorrectlyScoped[0]._meta,
        securitySchemes: [{ type: "oauth2", scopes: ["exomem.write"] }],
      },
    };
    await assert.rejects(run(incorrectlyScoped), /MCP_TOOLS_CONTRACT_MISMATCH/);
    const unexpectedExecution = completeTools();
    unexpectedExecution[0] = {
      ...unexpectedExecution[0],
      execution: { taskSupport: "optional" },
    };
    await assert.rejects(run(unexpectedExecution), /MCP_TOOLS_CONTRACT_MISMATCH/);
    const changedFastMcp = completeTools();
    changedFastMcp[0] = {
      ...changedFastMcp[0],
      _meta: { ...changedFastMcp[0]._meta, fastmcp: { tags: ["changed"] } },
    };
    await assert.rejects(run(changedFastMcp), /MCP_TOOLS_CONTRACT_MISMATCH/);
    const changedOutputTemplate = completeTools();
    changedOutputTemplate[0] = {
      ...changedOutputTemplate[0],
      outputSchema: { ...changedOutputTemplate[0].outputSchema, "x-output-template": "changed" },
    };
    await assert.rejects(run(changedOutputTemplate), /MCP_TOOLS_CONTRACT_MISMATCH/);
    await assert.rejects(
      run(completeTools(), toolsResult(completeTools().slice(1), { nextCursor: "page-2" })),
      /MCP_TOOLS_PAGINATION_UNSUPPORTED/
    );
    await assert.rejects(
      run(completeTools(), toolsResult(completeTools(), { nextCursor: 2 })),
      /MCP_TOOLS_CONTRACT_INVALID/
    );
    await assert.rejects(
      run(completeTools(), { result: { tools: completeTools() } }),
      /MCP_TOOLS_ENVELOPE_INVALID/
    );
    await assert.rejects(
      run(completeTools(), { ...toolsResult(completeTools()), id: 3 }),
      /MCP_TOOLS_RESPONSE_ID_MISMATCH/
    );
    await assert.rejects(
      run(completeTools(), {
        ...toolsResult(completeTools()),
        error: { code: -1, message: "secret" },
      }),
      /MCP_TOOLS_ENVELOPE_INVALID/
    );
    await assert.rejects(
      run(completeTools(), undefined, { result: { protocolVersion: "2025-06-18" } }),
      /MCP_INITIALIZE_ENVELOPE_INVALID/
    );
    await assert.rejects(
      run(completeTools(), undefined, { ...initializeResult(), id: 2 }),
      /MCP_INITIALIZE_RESPONSE_ID_MISMATCH/
    );
    await assert.rejects(
      run(
        completeTools(),
        undefined,
        initializeResult({
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "exomem", version: "0.33.0" },
        })
      ),
      /MCP_INITIALIZE_TOOLS_CAPABILITY_MISSING/
    );
    await assert.rejects(
      run(completeTools(), undefined, initializeResult({ protocolVersion: "2025-06-18" })),
      /MCP_INITIALIZE_CONTRACT_INVALID/
    );
    await assert.rejects(
      run(
        completeTools(),
        undefined,
        initializeResult({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { version: "0.33.0" },
        })
      ),
      /MCP_INITIALIZE_CONTRACT_INVALID/
    );
    await assert.rejects(
      run(
        completeTools(),
        undefined,
        initializeResult({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "Other service", version: exomemHostedContractFixture.sourceRelease },
        })
      ),
      /MCP_INITIALIZE_IDENTITY_MISMATCH/
    );
    await assert.rejects(
      run(
        completeTools(),
        undefined,
        initializeResult({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "Hosted Exomem", version: "0.0.0" },
        })
      ),
      /MCP_INITIALIZE_IDENTITY_MISMATCH/
    );
    await assert.rejects(
      run(
        completeTools(),
        undefined,
        initializeResult({
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Hosted Exomem", version: exomemHostedContractFixture.sourceRelease },
        })
      ),
      /MCP_INITIALIZE_CAPABILITIES_MISMATCH/
    );
    await assert.rejects(
      run(completeTools(), undefined, undefined, "text/plain"),
      /MCP_INITIALIZE_MEDIA_TYPE_INVALID/
    );
    await assert.rejects(
      run(completeTools(), undefined, undefined, undefined, "text/event-stream"),
      /MCP_TOOLS_MEDIA_TYPE_INVALID/
    );
    const charsetJson = await run(
      completeTools(),
      undefined,
      undefined,
      "application/json; charset=utf-8",
      "application/json; charset=utf-8"
    );
    assert.equal(charsetJson.authenticated?.initializeStatus, 200);
  });

  it("fails when a reachable public page loses a required semantic marker", async () => {
    await assert.rejects(
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/.well-known/openai-apps-challenge") return domainChallenge("expected");
          if (path === "/api/exomem/mcp/v1") {
            const requestOrigin = (init?.headers as Record<string, string> | undefined)?.origin;
            return requestOrigin === "https://attacker.invalid"
              ? new Response(null, { status: 403 })
              : new Response(null, {
                  status: 401,
                  headers: { "www-authenticate": 'Bearer resource_metadata="x"' },
                });
          }
          if (path.includes("oauth-protected-resource")) return protectedMetadata();
          if (path.includes("oauth-authorization-server")) return authorizationMetadata();
          if (path === "/exomem/privacy") return new Response("retention and plaintext only");
          return publicPage(path);
        },
      }),
      /PUBLIC_PAGE_CONTRACT_MISMATCH:\/exomem\/privacy/
    );
  });

  it("fails when an attacker Origin is not rejected content-free", async () => {
    await assert.rejects(
      runMarketplacePreflight({
        origin,
        timeoutMs: 100,
        challenge: "expected",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/.well-known/openai-apps-challenge") return domainChallenge("expected");
          if (path === "/api/exomem/mcp/v1") {
            const requestOrigin = (init?.headers as Record<string, string> | undefined)?.origin;
            return requestOrigin === "https://attacker.invalid"
              ? new Response("diagnostic", { status: 403 })
              : new Response(null, {
                  status: 401,
                  headers: {
                    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/exomem/mcp/v1"`,
                  },
                });
          }
          if (path.includes("oauth-protected-resource")) return protectedMetadata();
          if (path.includes("oauth-authorization-server")) return authorizationMetadata();
          return publicPage(path);
        },
      }),
      /MCP_ORIGIN_REJECTION/
    );
  });
});
