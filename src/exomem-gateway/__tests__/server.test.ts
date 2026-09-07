import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { describe, it } from "node:test";
import { createGatewayServer, drainGatewayServer, validateGatewayEnvironment } from "../server";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connectedSocket(port: number) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  return socket;
}

async function readHeaders(socket: ReturnType<typeof connect>): Promise<string> {
  let output = "";
  socket.on("data", (chunk) => {
    output += chunk.toString();
  });
  await waitFor(() => output.includes("\r\n\r\n"), "HTTP response headers");
  return output;
}

describe("standalone Exomem gateway adapter", () => {
  it("refuses to start without the control-plane and fixed transport contract", () => {
    assert.throws(
      () => validateGatewayEnvironment({ DATABASE_URL: "postgres://gateway" }),
      /EXOMEM_CONTROL_PLANE_KEY/
    );
  });

  it("serves only probes and the canonical MCP resource with private no-store responses", async () => {
    const server = createGatewayServer({
      handleMcp: async () => new Response("streamed", { headers: { "mcp-session-id": "session" } }),
    });
    const baseUrl = await listen(server);
    try {
      for (const path of ["/healthz", "/readyz"]) {
        const response = await fetch(`${baseUrl}${path}`);
        assert.equal(response.status, 200);
      }
      const response = await fetch(`${baseUrl}/api/exomem/mcp/v1`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "streamed");
      assert.equal(response.headers.get("mcp-session-id"), "session");
      assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
      assert.equal(response.headers.get("x-vercel-enable-rewrite-caching"), "0");
      assert.equal((await fetch(`${baseUrl}/api/exomem/admin`)).status, 404);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("cancels an aborted response stream and frees the inflight slot", async () => {
    let cancelled = false;
    let calls = 0;
    const server = createGatewayServer({
      maxInflight: 1,
      handleMcp: async () => {
        calls += 1;
        if (calls > 1) return new Response("second");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
            cancel() {
              cancelled = true;
            },
          })
        );
      },
    });
    const baseUrl = await listen(server);
    const abort = new AbortController();
    try {
      const first = await fetch(`${baseUrl}/api/exomem/mcp/v1`, {
        method: "POST",
        signal: abort.signal,
      });
      assert.equal(first.status, 200);
      abort.abort();
      await waitFor(() => cancelled, "stream cancellation");
      const second = await fetch(`${baseUrl}/api/exomem/mcp/v1`, { method: "POST" });
      assert.equal(second.status, 200);
      assert.equal(await second.text(), "second");
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });

  it("returns readiness failure during drain and closes an active stream at the deadline", async () => {
    const server = createGatewayServer({
      handleMcp: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streaming"));
            },
          })
        ),
    });
    const baseUrl = await listen(server);
    const active = await fetch(`${baseUrl}/api/exomem/mcp/v1`, { method: "POST" });
    assert.equal(active.status, 200);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const readySocket = await connectedSocket(address.port);
    const started = Date.now();
    const draining = drainGatewayServer(server, 25);
    readySocket.write("GET /readyz HTTP/1.1\r\nHost: gateway.test\r\nConnection: close\r\n\r\n");
    assert.match(await readHeaders(readySocket), /^HTTP\/1\.1 503 /);
    await draining;
    assert.ok(Date.now() - started < 500, "drain must not outlive its deadline");
    await assert.rejects(active.text());
  });

  it("returns bounded bad-request output when a malformed Host reaches the adapter", async () => {
    const server = createGatewayServer({ handleMcp: async () => new Response("unreachable") });
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const socket = await connectedSocket(address.port);
    socket.write(
      "POST /api/exomem/mcp/v1 HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    assert.match(await readHeaders(socket), /^HTTP\/1\.1 400 /);
    server.close();
    await once(server, "close");
  });
});
