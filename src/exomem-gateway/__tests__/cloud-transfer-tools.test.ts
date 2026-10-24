import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, JSONRPCResponseSchema } from "@modelcontextprotocol/sdk/types.js";
import { deriveCloudCellBearer } from "../../lib/exomem-hosted/cloud-cell-bearer";
import type { ExomemCloudConfig } from "../../lib/exomem-hosted/cloud-config";
import type { ActiveCloudOAuthAccessToken } from "../../lib/exomem-hosted/cloud-oauth";
import {
  handleCloudMcpRequest,
  resetCloudGatewayConcurrencyForTests,
  type CloudGatewayDependencies,
} from "../cloud-handler";

// The gateway serves observe_transfer and transfer_memory from the control
// plane (serve-cloud-transfer-tools). The cell is a stub that fails when
// called, and the web API is a recording stub, so each case shows what the
// gateway sent and where.

const CELL_ID = "aaaaaaaaaaaaaaaa";
const MCP_URL = "https://cloud.example.test/mcp/v1";
const PUBLIC_BASE = "https://exomem.example.test";
const CALLER_BEARER = "c".repeat(43);
const IMPORT_ID = "11111111-1111-4111-8111-111111111111";
const EXPORT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_EXPORT_ID = "33333333-3333-4333-8333-333333333333";
const PART_URL = "https://objects.example.test/part-1?X-Amz-Signature=capability-signature";
const RECIPIENT = "age1recipientcapabilityvalue";
const EXPORT_LINK = "https://objects.example.test/archive?X-Amz-Signature=download-signature";
const CAPABILITY_MARKERS = [
  PART_URL,
  "capability-signature",
  RECIPIENT,
  "part_urls",
  "urls_expire_at",
  "ciphertext_",
  "recipient",
  EXPORT_LINK,
  "download-signature",
  "archive_sha256",
];

const CONFIG: ExomemCloudConfig = {
  mcpUrl: MCP_URL,
  mcpPath: "/api/exomem/cloud/mcp/v1",
  cellTokenKey: Buffer.alloc(32, 7),
  transferToolsEnabled: true,
};

const ACCESS: ActiveCloudOAuthAccessToken = {
  familyId: "family-1",
  grantId: "grant-1",
  userId: "user-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  resource: MCP_URL,
  scopes: ["exomem.read", "exomem.write"],
  cellId: CELL_ID,
  cellDesiredState: "running",
  client: {
    clientName: null,
    admissionMode: "cimd",
    platform: "claude",
    redirectUris: ["https://chat.example.test/oauth/callback"],
  },
  firstParty: false,
};
const CODING_CLIENT = {
  ...ACCESS.client,
  redirectUris: ["http://127.0.0.1:53682/callback"],
};

function importRow(overrides: Record<string, unknown> = {}) {
  return {
    import_id: IMPORT_ID,
    kind: "adopt",
    declared_bytes: 2048,
    declared_files: 3,
    requested_state: "requested",
    observed_state: "importing",
    recipient: RECIPIENT,
    part_urls: [{ part_number: 1, url: PART_URL, part_size_bytes: 2048 }],
    urls_expire_at: "2026-10-24T10:00:00Z",
    error_code: null,
    ciphertext_sha256: "ab".repeat(32),
    ciphertext_bytes: 2100,
    created_at: "2026-10-24T09:00:00Z",
    updated_at: "2026-10-24T09:05:00Z",
    ...overrides,
  };
}

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    state: "ready",
    export_id: EXPORT_ID,
    requested_at: "2026-10-24T09:00:00Z",
    ready_at: "2026-10-24T09:10:00Z",
    expires_at: "2026-10-25T09:10:00Z",
    archive_bytes: 4096,
    archive_sha256: "cd".repeat(32),
    pauses_assistants: false,
    ...overrides,
  };
}

type WebCall = {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
  init: RequestInit;
};
type WebAnswer = Response | Error;

/** A recording stand-in for the Substrate web API; an unlisted route is a test failure. */
function webApi(routes: Record<string, WebAnswer | (() => WebAnswer)>) {
  const calls: WebCall[] = [];
  const fetchControlPlane = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.href,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      init: init ?? {},
    });
    const route = routes[`${method} ${url.pathname}`];
    assert.ok(route, `no stand-in route for ${method} ${url.pathname}`);
    const answer = typeof route === "function" ? route() : route;
    if (answer instanceof Error) throw answer;
    // A fresh response per call: a reused one would share its body stream with the earlier call.
    return new Response(await answer.clone().text(), {
      status: answer.status,
      headers: answer.headers,
    });
  }) as typeof fetch;
  return { calls, fetchControlPlane };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A cell that has stopped answering: any contact with it fails the test. */
function unreachableCell() {
  const calls: Array<{ body: string }> = [];
  const fetchCell = (async () => {
    calls.push({ body: "" });
    throw new Error("cell unreachable");
  }) as unknown as typeof fetch;
  return { calls, fetchCell };
}

function deps(overrides: Partial<CloudGatewayDependencies> = {}): CloudGatewayDependencies {
  return {
    config: CONFIG,
    findAccessToken: async () => ACCESS,
    recordAppUse: async () => undefined,
    takeRateLimit: async () => true,
    fetchCell: unreachableCell().fetchCell,
    ...overrides,
  };
}

function rpc(id: unknown, name: string, args?: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function gatewayRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.invalid/api/exomem/cloud/mcp/v1", {
    method: "POST",
    headers: {
      authorization: `Bearer ${CALLER_BEARER}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function callTool(
  name: string,
  args: unknown,
  dependencies: CloudGatewayDependencies,
  id: unknown = "call-1"
) {
  const response = await handleCloudMcpRequest(gatewayRequest(rpc(id, name, args)), dependencies);
  return { response, text: await response.text() };
}

// Untyped on purpose: each case asserts the fields it names.
function structured(text: string) {
  return JSON.parse(text).result.structuredContent;
}

function assertNoCapability(text: string): void {
  for (const marker of CAPABILITY_MARKERS) {
    assert.ok(!text.includes(marker), `a result carried ${marker}`);
  }
}

describe("Cloud transfer tools in the gateway", () => {
  let savedBase: string | undefined;
  before(() => {
    savedBase = process.env.EXOMEM_PUBLIC_BASE_URL;
    process.env.EXOMEM_PUBLIC_BASE_URL = PUBLIC_BASE;
  });
  after(() => {
    if (savedBase === undefined) delete process.env.EXOMEM_PUBLIC_BASE_URL;
    else process.env.EXOMEM_PUBLIC_BASE_URL = savedBase;
  });
  beforeEach(() => resetCloudGatewayConcurrencyForTests());

  it("answers status while the cell is stopped, with only the caller's bearer sent to the web API", async () => {
    const web = webApi({
      "GET /api/exomem/cloud/imports": json({ import: importRow({ observed_state: "done" }) }),
      "GET /api/exomem/cloud/exports": json({ export: exportRow() }),
    });
    const cell = unreachableCell();
    const { response, text } = await callTool(
      "observe_transfer",
      {},
      deps({
        findAccessToken: async () => ({ ...ACCESS, cellDesiredState: "stopped" }),
        fetchControlPlane: web.fetchControlPlane,
        fetchCell: cell.fetchCell,
      })
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(cell.calls.length, 0);
    const result = structured(text);
    assert.equal(result.success, true);
    assert.equal(result.action, "status");
    assert.equal(result.import.import_id, IMPORT_ID);
    assert.equal(result.import.staged_folder, `_Imports/${IMPORT_ID}`);
    assert.deepEqual(result.import.next, {
      tool: "adoption_studio",
      arguments: { action: "start", path: `_Imports/${IMPORT_ID}` },
    });
    assert.equal(result.export.state, "ready");
    assert.deepEqual(result.export.download, {
      home_url: `${PUBLIC_BASE}/exomem/home#your-data`,
      cli_argv: [
        "uvx",
        "exomem",
        "cloud",
        "export",
        "--out",
        "<directory>",
        "--export-id",
        EXPORT_ID,
        "--mcp-url",
        MCP_URL,
        "--api-base-url",
        PUBLIC_BASE,
      ],
    });
    assertNoCapability(text);

    assert.deepEqual(
      web.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`).sort(),
      ["GET /api/exomem/cloud/exports", "GET /api/exomem/cloud/imports"]
    );
    for (const call of web.calls) {
      assert.equal(call.url.startsWith(`${PUBLIC_BASE}/`), true);
      assert.deepEqual([...call.headers.keys()].sort(), ["accept", "authorization"]);
      assert.equal(call.headers.get("authorization"), `Bearer ${CALLER_BEARER}`);
      assert.equal(call.init.redirect, "error");
    }
  });

  it("refuses a malformed id or an unknown key before any web call", async () => {
    const web = webApi({});
    const dependencies = deps({ fetchControlPlane: web.fetchControlPlane });
    for (const args of [
      { action: "status", import_id: "../../admin" },
      { action: "status", extra: true },
      { action: "delete_everything" },
    ]) {
      const { response, text } = await callTool("observe_transfer", args, dependencies);
      assert.equal(response.status, 200);
      assert.equal(structured(text).success, false);
      assert.equal(structured(text).error.code, "INVALID_ARGUMENTS");
    }
    const missingId = await callTool("transfer_memory", { action: "import_cancel" }, dependencies);
    assert.equal(structured(missingId.text).error.code, "INVALID_ARGUMENTS");
    const nonUuid = await callTool(
      "transfer_memory",
      { action: "export_request", export_id: "not-a-uuid", confirm: true },
      dependencies
    );
    assert.equal(structured(nonUuid.text).error.code, "INVALID_ARGUMENTS");
    assert.equal(web.calls.length, 0);
  });

  it("answers a web 401 as a tool result and never as an HTTP challenge", async () => {
    const web = webApi({
      "GET /api/exomem/cloud/imports": json(
        {
          success: false,
          error: { code: "ACCESS_TOKEN_INVALID", message: "the token has expired" },
        },
        401
      ),
      "GET /api/exomem/cloud/exports": json(
        {
          success: false,
          error: { code: "ACCESS_TOKEN_INVALID", message: "the token has expired" },
        },
        401
      ),
    });
    const { response, text } = await callTool(
      "observe_transfer",
      { action: "status" },
      deps({ fetchControlPlane: web.fetchControlPlane })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("www-authenticate"), null);
    const result = structured(text);
    assert.equal(result.success, true);
    assert.deepEqual(result.import, {
      error: {
        code: "ACCESS_TOKEN_INVALID",
        message: "the token has expired",
        remediation: "reconnect",
      },
    });
    assert.equal(JSON.parse(text).result.isError, false);
  });

  it("reports an unreachable control plane as CONTROL_PLANE_UNAVAILABLE and keeps the other half", async () => {
    const web = webApi({
      "GET /api/exomem/cloud/imports": json({ error: "boom" }, 503),
      "GET /api/exomem/cloud/exports": new DOMException("timed out", "TimeoutError"),
    });
    const status = await callTool(
      "observe_transfer",
      {},
      deps({ fetchControlPlane: web.fetchControlPlane })
    );
    const result = structured(status.text);
    assert.equal(result.import.error.code, "CONTROL_PLANE_UNAVAILABLE");
    assert.equal(result.import.error.remediation, "retry");
    assert.equal(result.export.error.code, "CONTROL_PLANE_UNAVAILABLE");

    const oneHalf = webApi({
      "GET /api/exomem/cloud/imports": json({ import: null }),
      "GET /api/exomem/cloud/exports": json({}, 502),
    });
    const partial = structured(
      (
        await callTool(
          "observe_transfer",
          {},
          deps({ fetchControlPlane: oneHalf.fetchControlPlane })
        )
      ).text
    );
    assert.equal(partial.import, null);
    assert.equal(partial.export.error.code, "CONTROL_PLANE_UNAVAILABLE");

    const handoff = await callTool(
      "observe_transfer",
      { action: "import_handoff" },
      deps({ fetchControlPlane: web.fetchControlPlane })
    );
    assert.equal(structured(handoff.text).success, false);
    assert.equal(structured(handoff.text).error.code, "CONTROL_PLANE_UNAVAILABLE");
  });

  it("reports exports as not offered when the web API answers 404", async () => {
    const web = webApi({
      "GET /api/exomem/cloud/imports": json({ import: null }),
      "GET /api/exomem/cloud/exports": json({ success: false, error: { code: "NOT_FOUND" } }, 404),
    });
    const { text } = await callTool(
      "observe_transfer",
      {},
      deps({ fetchControlPlane: web.fetchControlPlane })
    );
    assert.deepEqual(structured(text).export, {
      state: "unavailable",
      code: "EXPORTS_NOT_OFFERED",
    });
  });

  it("orders the import routes by client context and offers attachments only where grants are signed", async () => {
    const web = webApi({
      "GET /api/exomem/cloud/imports": json({
        import: importRow({ observed_state: "importing" }),
      }),
    });
    const { privateKey } = generateKeyPairSync("ed25519");
    const signing = { artifactSigningKey: privateKey, artifactCells: new Set([CELL_ID]) };
    const conversation = structured(
      (
        await callTool(
          "observe_transfer",
          { action: "import_handoff" },
          deps({ fetchControlPlane: web.fetchControlPlane })
        )
      ).text
    );
    assert.deepEqual(
      conversation.routes.map((route: { kind: string }) => route.kind),
      ["browser", "cli"]
    );
    assert.equal(conversation.open_import.import_id, IMPORT_ID);

    const coding = structured(
      (
        await callTool(
          "observe_transfer",
          { action: "import_handoff" },
          deps({
            fetchControlPlane: web.fetchControlPlane,
            config: { ...CONFIG, ...signing },
            findAccessToken: async () => ({ ...ACCESS, client: CODING_CLIENT }),
          })
        )
      ).text
    );
    assert.deepEqual(
      coding.routes.map((route: { kind: string }) => route.kind),
      ["cli", "browser", "attachments"]
    );
    const [cli, browser, attachments] = coding.routes;
    assert.deepEqual(cli.argv_folder, [
      "uvx",
      "exomem",
      "cloud",
      "import",
      "<folder>",
      "--mcp-url",
      MCP_URL,
      "--api-base-url",
      PUBLIC_BASE,
    ]);
    assert.deepEqual(cli.argv_zip, [
      "uvx",
      "exomem",
      "cloud",
      "import",
      "<file.zip>",
      "--scope",
      "<scope>",
      "--category",
      "<category>",
      "--mcp-url",
      MCP_URL,
      "--api-base-url",
      PUBLIC_BASE,
    ]);
    assert.equal(browser.home_url, `${PUBLIC_BASE}/exomem/home#your-data`);
    assert.deepEqual(attachments, {
      kind: "attachments",
      tools: ["capture_source", "preserve_artifacts"],
      max_files: 8,
      max_bytes: 100 * 1024 * 1024,
    });
    assertNoCapability(JSON.stringify(coding));
  });

  it("writes nothing until confirm, then relays the import and export writes", async () => {
    const web = webApi({
      "GET /api/exomem/cloud/imports/11111111-1111-4111-8111-111111111111": json({
        import: importRow(),
      }),
      "GET /api/exomem/cloud/exports": json({ export: exportRow() }),
      "POST /api/exomem/cloud/imports/11111111-1111-4111-8111-111111111111/discard": json({
        import: importRow({
          requested_state: "discard_requested",
          observed_state: "cleanup_pending",
        }),
      }),
      "POST /api/exomem/cloud/imports/11111111-1111-4111-8111-111111111111/cancel": json({
        import: importRow({ requested_state: "cancelled", observed_state: "failed" }),
      }),
      "POST /api/exomem/cloud/exports": json({
        export: exportRow({ state: "packing", ready_at: undefined, pauses_assistants: true }),
      }),
    });
    const dependencies = deps({ fetchControlPlane: web.fetchControlPlane });

    const discard = structured(
      (
        await callTool(
          "transfer_memory",
          { action: "import_discard", import_id: IMPORT_ID },
          dependencies
        )
      ).text
    );
    assert.equal(discard.success, false);
    assert.equal(discard.error.code, "UNCONFIRMED");
    assert.equal(discard.import.import_id, IMPORT_ID);

    const request = structured(
      (await callTool("transfer_memory", { action: "export_request" }, dependencies)).text
    );
    assert.equal(request.error.code, "UNCONFIRMED");
    assert.deepEqual(request.effects, {
      pauses_assistants: false,
      supersedes_export_id: EXPORT_ID,
    });
    assert.match(request.export_id, /^[0-9a-f-]{36}$/);
    assert.equal(web.calls.filter((call) => call.method === "POST").length, 0);

    const discarded = structured(
      (
        await callTool(
          "transfer_memory",
          { action: "import_discard", import_id: IMPORT_ID, confirm: true },
          dependencies
        )
      ).text
    );
    assert.equal(discarded.success, true);
    assert.equal(discarded.import.requested_state, "discard_requested");
    const cancelled = structured(
      (
        await callTool(
          "transfer_memory",
          { action: "import_cancel", import_id: IMPORT_ID },
          dependencies
        )
      ).text
    );
    assert.equal(cancelled.import.requested_state, "cancelled");

    const started = structured(
      (
        await callTool(
          "transfer_memory",
          { action: "export_request", export_id: OTHER_EXPORT_ID, confirm: true },
          dependencies
        )
      ).text
    );
    assert.equal(started.success, true);
    assert.equal(started.export.state, "packing");
    assert.equal(started.export.pauses_assistants, true);
    const exportPost = web.calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/exports")
    );
    assert.deepEqual(JSON.parse(exportPost!.body!), { export_id: OTHER_EXPORT_ID });
    assert.equal(exportPost!.headers.get("authorization"), `Bearer ${CALLER_BEARER}`);
    assertNoCapability(JSON.stringify([discard, request, discarded, cancelled, started]));
  });

  it("relays the web API's own refusal of a write", async () => {
    const web = webApi({
      "POST /api/exomem/cloud/imports/11111111-1111-4111-8111-111111111111/cancel": json(
        {
          success: false,
          error: {
            code: "IMPORT_NOT_CANCELLABLE",
            message: "the import has finished",
            retryable: false,
          },
        },
        409
      ),
    });
    const { response, text } = await callTool(
      "transfer_memory",
      { action: "import_cancel", import_id: IMPORT_ID },
      deps({ fetchControlPlane: web.fetchControlPlane })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(structured(text), {
      success: false,
      error: {
        code: "IMPORT_NOT_CANCELLABLE",
        message: "the import has finished",
        remediation: "see_message",
      },
    });
  });

  it("passes everything else to the cell unchanged, and every call when the flag is off", async () => {
    const web = webApi({});
    const forwarded: Array<{ body: string; headers: Headers }> = [];
    const fetchCell = (async (_url: unknown, init?: RequestInit) => {
      forwarded.push({
        body: await new Response(init?.body as BodyInit).text(),
        headers: new Headers(init?.headers),
      });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { from: "cell" } });
    }) as unknown as typeof fetch;
    const dependencies = deps({ fetchControlPlane: web.fetchControlPlane, fetchCell });

    const transferOffBody = rpc(1, "observe_transfer", {});
    const flagOff = await handleCloudMcpRequest(gatewayRequest(transferOffBody), {
      ...dependencies,
      config: { ...CONFIG, transferToolsEnabled: false },
    });
    assert.deepEqual(await flagOff.json(), { jsonrpc: "2.0", id: 1, result: { from: "cell" } });

    const passThrough = [
      rpc(2, "search_memory", { query: "x" }),
      JSON.stringify([JSON.parse(rpc(3, "observe_transfer", {}))]),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "observe_transfer" },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      "{not json",
      // Past the 1 MiB read bound the body is replayed to the cell, not parsed.
      rpc(6, "search_memory", { query: "x".repeat(1536 * 1024) }),
    ];
    for (const body of passThrough) {
      const response = await handleCloudMcpRequest(gatewayRequest(body), dependencies);
      assert.equal(response.status, 200);
      await response.text(); // a relayed body holds its concurrency slot until it is read
    }
    const mismatched = rpc(5, "observe_transfer", {});
    const refused = await handleCloudMcpRequest(
      gatewayRequest(mismatched, { "mcp-name": "search_memory" }),
      dependencies
    );
    await refused.text();

    assert.deepEqual(
      forwarded.map((call) => call.body),
      [transferOffBody, ...passThrough, mismatched]
    );
    assert.equal(web.calls.length, 0);
    assert.equal(
      forwarded[0]!.headers.get("authorization"),
      `Bearer ${deriveCloudCellBearer(CONFIG.cellTokenKey, CELL_ID)}`
    );
  });

  it("serves a transfer call only behind the scope, rate-limit and bearer checks", async () => {
    const web = webApi({});
    const body = rpc(1, "observe_transfer", {});
    const unauthenticated = await handleCloudMcpRequest(
      new Request("http://gateway.invalid/x", { method: "POST", body }),
      deps({ fetchControlPlane: web.fetchControlPlane })
    );
    assert.equal(unauthenticated.status, 401);
    const readOnly = await handleCloudMcpRequest(
      gatewayRequest(body),
      deps({
        fetchControlPlane: web.fetchControlPlane,
        findAccessToken: async () => ({ ...ACCESS, scopes: ["exomem.read"] }),
      })
    );
    assert.equal(readOnly.status, 403);
    const limited = await handleCloudMcpRequest(
      gatewayRequest(body),
      deps({ fetchControlPlane: web.fetchControlPlane, takeRateLimit: async () => false })
    );
    assert.equal(limited.status, 429);
    assert.equal(web.calls.length, 0);
  });

  describe("with the official MCP client", () => {
    function cellStandIn(): typeof fetch {
      return (async (_url: unknown, init?: RequestInit) => {
        const message = JSON.parse(await new Response(init?.body as BodyInit).text());
        if (message.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "stand-in-cell", version: "0" },
            },
          });
        }
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch;
    }

    const webRoutes = {
      "GET /api/exomem/cloud/imports": json({ import: null }),
      "GET /api/exomem/cloud/exports": json({
        export: { state: "none", pauses_assistants: false },
      }),
    };

    it("parses the intercepted result of a numeric id call", async () => {
      const web = webApi(webRoutes);
      const dependencies = deps({
        fetchControlPlane: web.fetchControlPlane,
        fetchCell: cellStandIn(),
      });
      const transport = new StreamableHTTPClientTransport(new URL("http://gateway.invalid/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${CALLER_BEARER}` } },
        fetch: (input, init) => handleCloudMcpRequest(new Request(input, init), dependencies),
      });
      const client = new Client({ name: "transfer-test", version: "0" });
      await client.connect(transport);
      try {
        const result = CallToolResultSchema.parse(
          await client.callTool({ name: "observe_transfer", arguments: {} })
        );
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent?.success, true);
        assert.equal(result.structuredContent?.import, null);
        const [block] = result.content;
        assert.equal(block?.type, "text");
        assert.deepEqual(JSON.parse((block as { text: string }).text), result.structuredContent);
      } finally {
        await client.close();
      }
    });

    it("echoes a string id and a zero id exactly", async () => {
      const web = webApi(webRoutes);
      const dependencies = deps({ fetchControlPlane: web.fetchControlPlane });
      for (const id of ["req-7f3a", 0, 9007199254740991]) {
        const { text } = await callTool("observe_transfer", {}, dependencies, id);
        const message = JSONRPCResponseSchema.parse(JSON.parse(text));
        assert.ok("result" in message);
        assert.equal(message.id, id);
        assert.equal(CallToolResultSchema.parse(message.result).isError, false);
      }
    });
  });
});
