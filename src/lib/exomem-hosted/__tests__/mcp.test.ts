import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  mcpProtocolVersions: ["2025-11-25", "2025-06-18"],
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

function schemaSample(schema: unknown, root: unknown = schema): unknown {
  const record = schema as {
    $ref?: string;
    type?: string;
    const?: unknown;
    enum?: unknown[];
    anyOf?: unknown[];
    oneOf?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    minItems?: number;
    minimum?: number;
  };
  if (record.$ref?.startsWith("#/")) {
    const resolved = record.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], root);
    return schemaSample(resolved, root);
  }
  if (Object.hasOwn(record, "const")) return record.const;
  if (record.enum?.length) return record.enum[0];
  const variant = [...(record.anyOf ?? []), ...(record.oneOf ?? [])].find(
    (candidate) => (candidate as { type?: string }).type !== "null"
  );
  if (variant) return schemaSample(variant, root);
  if (record.type === "boolean") return false;
  if (record.type === "integer" || record.type === "number") return record.minimum ?? 0;
  if (record.type === "array")
    return Array.from({ length: Math.max(0, record.minItems ?? 0) }, () =>
      schemaSample(record.items, root)
    );
  if (record.type === "object" || record.properties) {
    return Object.fromEntries(
      (record.required ?? []).map((name) => [name, schemaSample(record.properties?.[name], root)])
    );
  }
  return "test";
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}

function bootstrapResult() {
  const command = LIVE.contract.agent_contract.commands.find(
    (candidate) => candidate.name === "bootstrap"
  );
  assert.ok(command);
  return {
    status: 200,
    requestId: "request",
    body: { success: true, data: schemaSample(command.mcp_tool.outputSchema) },
  };
}

describe("Hosted MCP boundary", () => {
  it("rejects recursively supplied routing and authentication selectors", () => {
    for (const value of [
      { tenantId: "other" },
      { resource: "other" },
      { requestId: "other" },
      { nested: { ask_memory: { filters: { profile: "other" } } } },
      { nested: { cellId: "other" } },
      { auth: { token: "other" } },
      { session: "other" },
    ]) {
      assert.equal(hasMcpSelector(value), true);
    }
  });

  it("rejects JSON-RPC batches before dispatching an MCP method", async () => {
    const response = await handleHostedMcpRequest(
      request([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => ACCESS,
        getLiveContract: async () => LIVE,
        takeRateLimit: async () => true,
      }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_REQUEST" });
  });

  it("uses stable sorted JSON for mutation retry binding", () => {
    assert.equal(
      canonicalMcpArguments({ b: [2, { z: true, a: false }], a: "value" }),
      canonicalMcpArguments({ a: "value", b: [2, { a: false, z: true }] })
    );
  });

  it("accepts only the application-supported MCP protocol versions", () => {
    assert.equal(mcpProtocolSupported("2025-06-18", LIVE.mcpProtocolVersions), true);
    assert.equal(mcpProtocolSupported("2099-01-01", LIVE.mcpProtocolVersions), false);
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

  it("returns stable preparing metadata without routing a tool to a cell", async () => {
    let routes = 0;
    const response = await handleHostedMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bootstrap", arguments: {} },
      }),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => ACCESS,
        getLiveContract: async () => LIVE,
        statusForTenant: async () => ({
          state: "preparing",
          code: "TENANT_PREPARING",
          retryable: true,
        }),
        routeCommand: async () => {
          routes += 1;
          throw new Error("must not route a preparing tenant");
        },
        takeRateLimit: async () => true,
      }
    );
    const payload = (await response.json()) as {
      result?: { _meta?: { exomem?: Record<string, unknown> }; content?: Array<{ text?: string }> };
    };
    assert.equal(routes, 0);
    assert.equal(payload.result?._meta?.exomem?.code, "TENANT_PREPARING");
    assert.equal(payload.result?._meta?.exomem?.retryable, true);
    assert.equal(payload.result?._meta?.exomem?.retryAfterMs, 1000);
    assert.equal(payload.result?._meta?.exomem?.remediation, "retry_later");
    assert.match(String(payload.result?._meta?.exomem?.requestId), /^[0-9a-f-]{36}$/i);
    assert.deepEqual(
      JSON.parse(payload.result?.content?.[0]?.text ?? "{}"),
      payload.result?._meta?.exomem
    );
  });

  it("keeps overlapping tenant-client calls counted until each call actually finishes", async () => {
    const waits: Array<ReturnType<typeof deferred>> = [];
    let started = 0;
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: async () => ACCESS,
      getLiveContract: async () => LIVE,
      statusForTenant: async () => {
        started += 1;
        const wait = deferred();
        waits.push(wait);
        await wait.promise;
        return { state: "ready", code: "READY", retryable: false };
      },
      routeCommand: async () => bootstrapResult(),
      takeRateLimit: async () => true,
    };
    const call = () =>
      handleHostedMcpRequest(
        request({
          jsonrpc: "2.0",
          id: Math.random(),
          method: "tools/call",
          params: { name: "bootstrap", arguments: {} },
        }),
        dependencies
      );
    const first = [call(), call(), call(), call()];
    while (started < 4) await new Promise((resolve) => setTimeout(resolve, 0));
    waits[0].resolve();
    await first[0];
    const overlap = [call(), call(), call()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(started, 5);
    for (const wait of waits) wait.resolve();
    await Promise.all([...first.slice(1), ...overlap]);
  });

  it("turns an aborted HTTP request into a stable MCP tool error before routing", async () => {
    const controller = new AbortController();
    const wait = deferred();
    let routes = 0;
    let lifecycleStarted = false;
    const pending = handleHostedMcpRequest(
      new Request("https://substratesystems.io/api/exomem/mcp/v1", {
        method: "POST",
        signal: controller.signal,
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "bootstrap", arguments: {} },
        }),
      }),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => ACCESS,
        getLiveContract: async () => LIVE,
        statusForTenant: async () => {
          lifecycleStarted = true;
          await wait.promise;
          return { state: "ready", code: "READY", retryable: false };
        },
        routeCommand: async () => {
          routes += 1;
          return bootstrapResult();
        },
        takeRateLimit: async () => true,
      }
    );
    while (!lifecycleStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const payload = (await (await pending).json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    wait.resolve();
    assert.equal(routes, 0);
    assert.match(payload.result?.content?.[0]?.text ?? "", /CELL_UNAVAILABLE/);
  });

  it("uses the official Streamable HTTP client for ordered discovery, calls, and content-free telemetry", async () => {
    const telemetry: Array<Record<string, unknown>> = [];
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: async () => ACCESS,
      getLiveContract: async () => LIVE,
      statusForTenant: async () => ({ state: "ready", code: "READY", retryable: false }),
      routeCommand: async (input: { commandName: string }) => {
        const command = LIVE.contract.agent_contract.commands.find(
          (candidate) => candidate.name === input.commandName
        );
        assert.ok(command);
        return {
          status: 200,
          requestId: "request",
          body: { success: true, data: schemaSample(command.mcp_tool.outputSchema) },
        };
      },
      takeRateLimit: async () => true,
      telemetry: (event: Record<string, unknown>) => telemetry.push(event),
      telemetryKey: Buffer.alloc(32, 7),
    };
    const transport = new StreamableHTTPClientTransport(
      new URL("https://substratesystems.io/api/exomem/mcp/v1"),
      {
        requestInit: { headers: { authorization: `Bearer ${"a".repeat(43)}` } },
        fetch: (input, init) =>
          handleHostedMcpRequest(new Request(input.toString(), init), dependencies),
      }
    );
    const client = new Client({ name: "acceptance", version: "1" });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      exomemHostedContractFixture.compatibility.agent_contract.commands.map(
        (command) => command.mcp_tool.name
      )
    );
    for (const tool of listed.tools) {
      const result = await client.callTool({
        name: tool.name,
        arguments: schemaSample(tool.inputSchema) as Record<string, unknown>,
      });
      assert.notEqual(result.isError, true, tool.name);
      assert.ok(result.structuredContent, tool.name);
    }
    await transport.close();
    assert.equal(telemetry.length, 13);
    const serialized = JSON.stringify(telemetry);
    assert.equal(serialized.includes("client-secret-sentinel"), false);
    assert.equal(serialized.includes("https://substratesystems.io/api/exomem/mcp/v1"), false);
    assert.equal(
      telemetry.every((event) => event.event === "mcp.request"),
      true
    );
  });
});
