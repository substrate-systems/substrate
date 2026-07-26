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
      "content-type": "application/json",
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
          requestId: "018f2d91-7c42-7000-8000-000000000101",
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
    assert.equal(payload.result?._meta?.exomem?.requestId, "018f2d91-7c42-7000-8000-000000000101");
    assert.deepEqual(
      JSON.parse(payload.result?.content?.[0]?.text ?? "{}"),
      payload.result?._meta?.exomem
    );
  });

  it("preserves only bounded private retry metadata while redacting the private error text", async () => {
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
        statusForTenant: async () => ({ state: "ready", code: "READY", retryable: false }),
        routeCommand: async () => ({
          status: 503,
          requestId: "request",
          body: {
            success: false,
            error: {
              code: "CELL_UNAVAILABLE",
              message: "private-cell-error-sentinel",
              retryable: true,
              retryAfterMs: 2000,
              remediation: "retry_later",
            },
          },
        }),
        takeRateLimit: async () => true,
      }
    );
    const payload = (await response.json()) as {
      result?: { content?: Array<{ text?: string }>; _meta?: { exomem?: Record<string, unknown> } };
    };
    const meta = payload.result?._meta?.exomem;
    assert.equal(meta?.retryAfterMs, 2000);
    assert.equal(meta?.remediation, "retry_later");
    assert.equal(JSON.stringify(payload).includes("private-cell-error-sentinel"), false);
    assert.deepEqual(JSON.parse(payload.result?.content?.[0]?.text ?? "{}"), meta);
  });

  it("overlays the exact discovery order with read/write OAuth scopes", async () => {
    const response = await handleHostedMcpRequest(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => ACCESS,
        getLiveContract: async () => LIVE,
        takeRateLimit: async () => true,
      }
    );
    const payload = (await response.json()) as {
      result?: { tools?: Array<{ name: string; _meta?: { securitySchemes?: unknown } }> };
    };
    const tools = payload.result?.tools ?? [];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      LIVE.contract.agent_contract.commands.map((command) => command.mcp_tool.name)
    );
    for (const command of LIVE.contract.agent_contract.commands) {
      const tool = tools.find((candidate) => candidate.name === command.name);
      assert.deepEqual(tool?._meta?.securitySchemes, [
        { type: "oauth2", scopes: [command.read_only ? "exomem.read" : "exomem.write"] },
      ]);
    }
  });

  it("accepts every bootstrap profile but rejects nested selectors before routing", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: async () => ACCESS,
      getLiveContract: async () => LIVE,
      statusForTenant: async () => ({ state: "ready", code: "READY", retryable: false }),
      routeCommand: async (input: { args: Record<string, unknown> }) => {
        seen.push(input.args);
        return bootstrapResult();
      },
      takeRateLimit: async () => true,
    };
    for (const profile of ["compact", "full", "diagnostics"]) {
      const response = await handleHostedMcpRequest(
        request({
          jsonrpc: "2.0",
          id: profile,
          method: "tools/call",
          params: { name: "bootstrap", arguments: { profile, workflow: "test" } },
        }),
        dependencies
      );
      assert.equal(response.status, 200);
    }
    const nested = await handleHostedMcpRequest(
      request({
        jsonrpc: "2.0",
        id: "nested",
        method: "tools/call",
        params: { name: "bootstrap", arguments: { nested: { profile: "full" } } },
      }),
      dependencies
    );
    const result = (await nested.json()) as { result?: { _meta?: { exomem?: { code?: string } } } };
    assert.equal(result.result?._meta?.exomem?.code, "HOSTED_SELECTOR_REJECTED");
    assert.deepEqual(seen, [
      { profile: "compact", workflow: "test" },
      { profile: "full", workflow: "test" },
      { profile: "diagnostics", workflow: "test" },
    ]);
  });

  it("rejects malformed, oversized, deep, and incompatible hosted requests before a cell route", async () => {
    let routes = 0;
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: async () => ACCESS,
      getLiveContract: async () => LIVE,
      takeRateLimit: async () => true,
      routeCommand: async () => {
        routes += 1;
        return bootstrapResult();
      },
    };
    const malformed = await handleHostedMcpRequest(
      new Request("https://substratesystems.io/api/exomem/mcp/v1", {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
        body: "{",
      }),
      dependencies
    );
    assert.equal(malformed.status, 400);
    const tooLarge = await handleHostedMcpRequest(
      request({ jsonrpc: "2.0" }, { "content-length": String(1024 * 1024 + 1) }),
      dependencies
    );
    assert.equal(tooLarge.status, 413);
    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth < 34; depth += 1) deep = { nested: deep };
    const excessiveDepth = await handleHostedMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "bootstrap", arguments: deep },
      }),
      dependencies
    );
    assert.equal(excessiveDepth.status, 400);
    const incompatible = await handleHostedMcpRequest(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      {
        ...dependencies,
        getLiveContract: async () => ({ ...LIVE, profile: "private-profile" }) as never,
      }
    );
    assert.equal(incompatible.status, 503);
    assert.equal(routes, 0);
  });

  it("maps every non-ready lifecycle result to the stable JSON and metadata envelope", async () => {
    const cases = [
      ["capacity", "CAPACITY_UNAVAILABLE", true, "retry_later"],
      ["degraded", "CELL_FAILED", false, "contact_support"],
      ["suspended", "EXOMEM_SUSPENDED", false, "contact_support"],
      ["deleted", "EXOMEM_DELETED", false, "contact_support"],
      ["deleting", "DELETION_IN_PROGRESS", false, "deletion_in_progress"],
    ] as const;
    for (const [state, code, retryable, remediation] of cases) {
      const response = await handleHostedMcpRequest(
        request({
          jsonrpc: "2.0",
          id: code,
          method: "tools/call",
          params: { name: "bootstrap", arguments: {} },
        }),
        {
          baseUrl: "https://substratesystems.io",
          findAccessToken: async () => ACCESS,
          getLiveContract: async () => LIVE,
          statusForTenant: async () => ({ state, code, retryable }),
          routeCommand: async () => {
            throw new Error("must not route a non-ready lifecycle");
          },
          takeRateLimit: async () => true,
        }
      );
      const payload = (await response.json()) as {
        result?: {
          content?: Array<{ text?: string }>;
          _meta?: { exomem?: Record<string, unknown> };
        };
      };
      const meta = payload.result?._meta?.exomem;
      assert.equal(meta?.retryable, retryable, code);
      assert.equal(meta?.remediation, remediation, code);
      assert.deepEqual(JSON.parse(payload.result?.content?.[0]?.text ?? "{}"), meta, code);
    }
  });

  it("emits only opaque allowlisted telemetry for a denied selector containing privacy sentinels", async () => {
    const events: Array<Record<string, unknown>> = [];
    await handleHostedMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bootstrap",
          arguments: { profile: "compact", nested: { authorization: "bearer-secret-sentinel" } },
        },
      }),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => ({ ...ACCESS, clientId: "client-secret-sentinel" }),
        getLiveContract: async () => LIVE,
        takeRateLimit: async () => true,
        telemetry: (event: Record<string, unknown>) => events.push(event),
        telemetryKey: Buffer.alloc(32, 9),
      }
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "mcp.request");
    assert.equal(events[0].outcome, "denied");
    assert.equal(events[0].errorCode, "HOSTED_SELECTOR_REJECTED");
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("bearer-secret-sentinel"), false);
    assert.equal(serialized.includes("client-secret-sentinel"), false);
  });

  it("emits a content-free denial event after authentication for an unsupported protocol", async () => {
    const events: Array<Record<string, unknown>> = [];
    const response = await handleHostedMcpRequest(
      request(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { "mcp-protocol-version": "2099-01-01" }
      ),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => ({ ...ACCESS, clientId: "client-secret-sentinel" }),
        getLiveContract: async () => LIVE,
        takeRateLimit: async () => true,
        telemetry: (event: Record<string, unknown>) => events.push(event),
        telemetryKey: Buffer.alloc(32, 8),
      }
    );
    assert.equal(response.status, 400);
    assert.equal(events.length, 1);
    assert.deepEqual(
      { event: events[0].event, outcome: events[0].outcome, errorCode: events[0].errorCode },
      { event: "mcp.request", outcome: "denied", errorCode: "MCP_PROTOCOL_UNSUPPORTED" }
    );
    assert.equal(JSON.stringify(events).includes("client-secret-sentinel"), false);
  });

  it("keeps unauthenticated denial telemetry free of bearer and body sentinels", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bearer = "bearer-secret-sentinel";
    const response = await handleHostedMcpRequest(
      new Request("https://substratesystems.io/api/exomem/mcp/v1", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ private: "body-secret-sentinel" }),
      }),
      {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => null,
        takeRateLimit: async () => true,
        telemetry: (event: Record<string, unknown>) => events.push(event),
        telemetryKey: Buffer.alloc(32, 8),
      }
    );
    assert.equal(response.status, 401);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "denied");
    assert.equal(events[0].errorCode, "ACCESS_TOKEN_INVALID");
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(bearer), false);
    assert.equal(serialized.includes("body-secret-sentinel"), false);
    assert.equal(Object.hasOwn(events[0], "clientHash"), false);
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

  it("rejects excess authenticated requests before live-contract loading", async () => {
    const waits: Array<ReturnType<typeof deferred>> = [];
    let liveReads = 0;
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: async () => ACCESS,
      getLiveContract: async () => {
        liveReads += 1;
        const wait = deferred();
        waits.push(wait);
        await wait.promise;
        return LIVE;
      },
      takeRateLimit: async () => true,
    };
    const call = () =>
      handleHostedMcpRequest(
        request({ jsonrpc: "2.0", id: Math.random(), method: "tools/list" }),
        dependencies
      );
    const first = [call(), call(), call(), call()];
    while (liveReads < 4) await new Promise((resolve) => setTimeout(resolve, 0));
    const excess = await call();
    assert.equal(excess.status, 429);
    assert.equal(liveReads, 4);
    for (const wait of waits) wait.resolve();
    await Promise.all(first);
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

  it("uses one abort deadline through private routing and releases the tenant-client slot", async () => {
    const controller = new AbortController();
    const routeWait = deferred();
    let routes = 0;
    const dependencies = {
      baseUrl: "https://substratesystems.io",
      findAccessToken: async () => ACCESS,
      getLiveContract: async () => LIVE,
      statusForTenant: async () => ({ state: "ready", code: "READY", retryable: false }),
      routeCommand: async (input: { dependencies?: { signal?: AbortSignal } }) => {
        routes += 1;
        assert.equal(input.dependencies?.signal?.aborted, false);
        if (routes === 1) await routeWait.promise;
        return bootstrapResult();
      },
      takeRateLimit: async () => true,
    };
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
      dependencies
    );
    while (routes !== 1) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const first = await pending;
    assert.equal(first.status, 200);
    const second = await handleHostedMcpRequest(
      request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "bootstrap", arguments: {} },
      }),
      dependencies
    );
    assert.equal(second.status, 200);
    assert.equal(routes, 2);
    routeWait.resolve();
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
    assert.equal(telemetry.length, 16);
    assert.equal(telemetry.filter((event) => event.requestClass === "tool").length, 13);
    assert.equal(telemetry.filter((event) => event.requestClass === "request").length, 3);
    const serialized = JSON.stringify(telemetry);
    assert.equal(serialized.includes("client-secret-sentinel"), false);
    assert.equal(serialized.includes("https://substratesystems.io/api/exomem/mcp/v1"), false);
    assert.equal(
      telemetry.every((event) => event.event === "mcp.request"),
      true
    );
  });
});
