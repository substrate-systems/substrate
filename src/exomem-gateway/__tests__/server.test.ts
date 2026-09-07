import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { createGatewayServer } from "../server";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

describe("standalone Exomem gateway adapter", () => {
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
});
