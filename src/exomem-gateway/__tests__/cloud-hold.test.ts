import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { after, beforeEach, describe, it } from "node:test";
import type { ExomemCloudConfig } from "../../lib/exomem-hosted/cloud-config";
import type { ActiveCloudOAuthAccessToken } from "../../lib/exomem-hosted/cloud-oauth";
import { MAX_PREPARED_BODY_BYTES, readCloudArtifactBody } from "../cloud-artifacts";
import {
  handleCloudMcpRequest,
  resetCloudGatewayConcurrencyForTests,
  type CloudGatewayDependencies,
} from "../cloud-handler";
import { loadCloudUpstream, type CloudUpstream } from "../cloud-upstream";
import { HOLD_OFF_ENV } from "./upstream-fixture";

// Design D5 of `automate-cloud-releases`: the gateway hold and the upstream
// timeouts, against stand-in cells on real sockets and the real undici
// dispatcher, so the connect, header and idle timeouts are the ones the
// gateway runs with.

const CONFIG: ExomemCloudConfig = {
  mcpUrl: "https://cloud.example.test/mcp/v1",
  mcpPath: "/mcp/v1",
  cellTokenKey: Buffer.alloc(32, 7),
};

function access(tenantId: string, cellId: string): ActiveCloudOAuthAccessToken {
  return {
    familyId: `family-${tenantId}`,
    grantId: `grant-${tenantId}`,
    userId: `user-${tenantId}`,
    tenantId,
    clientId: "client-1",
    resource: CONFIG.mcpUrl,
    scopes: ["exomem.read", "exomem.write"],
    cellId,
    cellDesiredState: "running",
    client: {
      clientName: null,
      admissionMode: "cimd",
      platform: "claude",
      redirectUris: ["https://chat.example.test/oauth/callback"],
    },
    firstParty: false,
  };
}

const TENANT_A = access("tenant-a", "aaaaaaaaaaaaaaaa");
const TENANT_B = access("tenant-b", "bbbbbbbbbbbbbbbb");

const upstreams: CloudUpstream[] = [];
function upstream(overrides: Partial<typeof HOLD_OFF_ENV>): CloudUpstream {
  const settings = loadCloudUpstream({ ...HOLD_OFF_ENV, ...overrides });
  upstreams.push(settings);
  return settings;
}

function deps(
  who: ActiveCloudOAuthAccessToken,
  port: number,
  settings: CloudUpstream
): CloudGatewayDependencies {
  return {
    config: CONFIG,
    findAccessToken: async () => who,
    recordAppUse: async () => undefined,
    takeRateLimit: async () => true,
    upstream: settings,
    cellOrigin: () => `http://127.0.0.1:${port}`,
  };
}

function mcpRequest(body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', signal?: AbortSignal) {
  return new Request("http://gateway.invalid/mcp/v1", {
    method: "POST",
    headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" },
    body,
    signal,
  });
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A cell on a fixed port that a test stops (connections refused) and starts again. */
class StandInCell {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  received: string[] = [];

  private constructor(readonly port: number) {}

  /** A cell that refuses connections until the test starts it. */
  static async stopped(): Promise<StandInCell> {
    const probe = createTcpServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    probe.close();
    await once(probe, "close");
    return new StandInCell(address.port);
  }

  async start(handler: Handler): Promise<void> {
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      this.received.push(body);
      handler(request, response);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    server.listen(this.port, "127.0.0.1");
    await once(server, "listening");
    this.server = server;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.close();
    for (const socket of this.sockets) socket.destroy();
    await once(server, "close");
  }
}

const answerOk: Handler = (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
};

const cells: StandInCell[] = [];
async function stoppedCell(): Promise<StandInCell> {
  const cell = await StandInCell.stopped();
  cells.push(cell);
  return cell;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Cloud gateway hold and upstream timeouts (D5)", () => {
  beforeEach(() => resetCloudGatewayConcurrencyForTests());
  after(async () => {
    for (const cell of cells) await cell.stop();
    await Promise.all(upstreams.map((settings) => settings.dispatcher.close()));
  });

  it(
    "answers a request with the cell's answer when the cell refuses for 5 seconds",
    { timeout: 15_000 },
    async () => {
      const cell = await stoppedCell();
      const settings = upstream({
        EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "10",
        EXOMEM_CLOUD_HOLD_INTERVAL_MS: "200",
        EXOMEM_CLOUD_HOLD_JITTER_MS: "50",
      });
      const restarted = pause(5_000).then(() => cell.start(answerOk));
      const started = Date.now();

      const response = await handleCloudMcpRequest(
        mcpRequest(),
        deps(TENANT_A, cell.port, settings)
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"jsonrpc":"2.0","id":1,"result":{}}');
      assert.ok(Date.now() - started >= 5_000);
      assert.deepEqual(cell.received, ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
      await restarted;
    }
  );

  it("never retries a request after the cell read its first byte", async () => {
    let connections = 0;
    const closing = createTcpServer((socket) => {
      connections += 1;
      socket.once("data", () => socket.destroy());
    });
    closing.listen(0, "127.0.0.1");
    await once(closing, "listening");
    const address = closing.address();
    assert.ok(address && typeof address !== "string");
    const settings = upstream({
      EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "10",
      EXOMEM_CLOUD_HOLD_INTERVAL_MS: "100",
    });
    try {
      const response = await handleCloudMcpRequest(
        mcpRequest(),
        deps(TENANT_A, address.port, settings)
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "CELL_NOT_READY" });
      await pause(500);
      assert.equal(connections, 1);
    } finally {
      closing.close();
    }
  });

  it("does not hold a body one byte over the cap, and forwards it whole", async () => {
    const cell = await stoppedCell();
    const settings = upstream({
      EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "10",
      EXOMEM_CLOUD_HOLD_INTERVAL_MS: "1000",
    });
    const oversized = "x".repeat(MAX_PREPARED_BODY_BYTES + 1);

    const started = Date.now();
    const refused = await handleCloudMcpRequest(
      mcpRequest(oversized),
      deps(TENANT_A, cell.port, settings)
    );
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), null);
    assert.ok(Date.now() - started < 1_000, "an oversized body waited in the hold");

    await cell.start(answerOk);
    const forwarded = await handleCloudMcpRequest(
      mcpRequest(oversized),
      deps(TENANT_A, cell.port, settings)
    );
    assert.equal(forwarded.status, 200);
    await forwarded.text();
    assert.equal(cell.received.length, 1);
    assert.equal(cell.received[0].length, MAX_PREPARED_BODY_BYTES + 1);
    assert.equal(cell.received[0], oversized);
  });

  it("sizes the prepared body from its content-length, not from the cap", async () => {
    const body = "y".repeat(1024);
    const prepared = await readCloudArtifactBody(
      new Request("http://gateway.invalid/mcp/v1", {
        method: "POST",
        headers: { "content-length": "1024" },
        body,
      })
    );
    assert.ok(prepared.inspected);
    assert.equal(Buffer.from(prepared.inspected).toString(), body);
    assert.equal(prepared.inspected.buffer.byteLength, 1024);
  });

  it("answers 503 with Retry-After when a tenant's hold is full, while another tenant proceeds", async () => {
    const restarting = await stoppedCell();
    const running = await stoppedCell();
    await running.start(answerOk);
    const settings = upstream({
      EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "10",
      EXOMEM_CLOUD_HOLD_INTERVAL_MS: "200",
      EXOMEM_CLOUD_HOLD_MAX: "8",
      EXOMEM_CLOUD_HOLD_MAX_PER_TENANT: "1",
      EXOMEM_CLOUD_HOLD_RETRY_AFTER_SECONDS: "7",
    });
    const leave = new AbortController();
    const held = handleCloudMcpRequest(
      mcpRequest(undefined, leave.signal),
      deps(TENANT_A, restarting.port, settings)
    );
    await pause(100);

    const started = Date.now();
    const refused = await handleCloudMcpRequest(
      mcpRequest(),
      deps(TENANT_A, restarting.port, settings)
    );
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "7");
    assert.deepEqual(await refused.json(), { error: "CELL_NOT_READY" });
    assert.ok(Date.now() - started < 200, "a request over the hold cap waited");

    const other = await handleCloudMcpRequest(mcpRequest(), deps(TENANT_B, running.port, settings));
    assert.equal(other.status, 200);
    await other.text();

    leave.abort();
    await (await held).text();
  });

  it("answers as a full in-flight cap when the cell accepts with no slot free, and frees the hold slot", async () => {
    const cell = await stoppedCell();
    const settings = upstream({
      EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "10",
      EXOMEM_CLOUD_HOLD_INTERVAL_MS: "400",
      EXOMEM_CLOUD_HOLD_MAX_PER_TENANT: "1",
    });
    const held = handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings));
    await pause(50);

    // The cell starts and four requests of the same tenant and client take
    // every in-flight slot that identity has, before the held one retries.
    await cell.start(() => undefined);
    const busy = Array.from({ length: 4 }, () =>
      handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings))
    );

    const answer = await held;
    assert.equal(answer.status, 429);
    assert.deepEqual(await answer.json(), { error: "RATE_LIMITED" });

    // The cell stops again. If the 429 kept its hold slot, the tenant's one
    // hold slot is taken and the next request is refused at once.
    await cell.stop();
    for (const response of await Promise.all(busy)) await response.text();
    const next = handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings));
    await pause(100);
    await cell.start(answerOk);
    const after = await next;
    assert.equal(after.status, 200);
    await after.text();
  });

  it("stops retrying at once when the client leaves", async () => {
    const cell = await stoppedCell();
    const settings = upstream({
      EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "10",
      EXOMEM_CLOUD_HOLD_INTERVAL_MS: "1000",
    });
    const leave = new AbortController();
    const held = handleCloudMcpRequest(
      mcpRequest(undefined, leave.signal),
      deps(TENANT_A, cell.port, settings)
    );
    await pause(300);
    const left = Date.now();
    leave.abort();
    const response = await held;
    assert.ok(Date.now() - left < 200, "the hold outlived its client");
    assert.equal(response.status, 503);
  });

  it(
    "answers 504 CELL_TIMEOUT when a cell sends no headers in time, and frees its slot",
    { timeout: 15_000 },
    async () => {
      const cell = await stoppedCell();
      let requests = 0;
      await cell.start((request, response) => {
        requests += 1;
        if (requests <= 4) return;
        answerOk(request, response);
      });
      const settings = upstream({ EXOMEM_CLOUD_UPSTREAM_TIMEOUT_SECONDS: "1" });

      // Four requests fill the identity's in-flight cap; each times out.
      const hung = await Promise.all(
        Array.from({ length: 4 }, () =>
          handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings))
        )
      );
      for (const response of hung) {
        assert.equal(response.status, 504);
        assert.deepEqual(await response.json(), { error: "CELL_TIMEOUT" });
      }

      const next = await handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings));
      assert.equal(next.status, 200);
      await next.text();
    }
  );

  it(
    "closes a stream that stalls after its SSE headers, and frees its slot",
    { timeout: 15_000 },
    async () => {
      const cell = await stoppedCell();
      let requests = 0;
      await cell.start((request, response) => {
        requests += 1;
        if (requests > 4) return answerOk(request, response);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: message\ndata: {}\n\n");
      });
      const settings = upstream({ EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS: "1" });

      const stalled = await Promise.all(
        Array.from({ length: 4 }, () =>
          handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings))
        )
      );
      for (const response of stalled) {
        assert.equal(response.status, 200);
        await assert.rejects(response.text());
      }

      const next = await handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings));
      assert.equal(next.status, 200);
      await next.text();
    }
  );

  it("answers at once when the hold budget is 0", async () => {
    const cell = await stoppedCell();
    const settings = upstream({
      EXOMEM_CLOUD_HOLD_BUDGET_SECONDS: "0",
      EXOMEM_CLOUD_HOLD_INTERVAL_MS: "1000",
    });
    const started = Date.now();
    const response = await handleCloudMcpRequest(mcpRequest(), deps(TENANT_A, cell.port, settings));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), null);
    assert.deepEqual(await response.json(), { error: "CELL_NOT_READY" });
    assert.ok(Date.now() - started < 500, "the hold ran with a budget of 0");
  });

  it("refuses settings that the chart did not render", () => {
    assert.throws(
      () => loadCloudUpstream({ ...HOLD_OFF_ENV, EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS: undefined }),
      /EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS/
    );
  });
});
