import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { proveMemoryRoundTrip, type MemoryHealthConfig } from "../memory-health";

// Direct structured payloads match the real pinned kernel and edit.EditValidation/EditResult.
async function syntheticCell(
  options: { mismatch?: boolean; missingStructured?: boolean; hang?: boolean } = {}
) {
  let body = "";
  let requests = 0;
  const operations: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    requests += 1;
    assert.equal(request.headers.authorization, "Bearer isolated-cell-bearer");
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const message = JSON.parse(raw);
    if (options.hang) return;
    if (
      message.method === "notifications/initialized" ||
      message.method === "notifications/cancelled"
    ) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-cell", version: "1" },
      };
    } else {
      const arguments_ = message.params.arguments;
      assert.equal(arguments_.path, "Knowledge Base/Notes/Insights/synthetic-health.md");
      let data;
      if (message.params.name === "edit_memory") {
        assert.equal(arguments_.operation.kind, "replace_body");
        operations.push(arguments_.operation);
        if (arguments_.operation.validate_only) {
          data = {
            path: arguments_.path,
            validate_only: true,
            mode: "body",
            match_count: 0,
            matches: [],
            semantic: {
              transition_token: "opaque-transition",
              relation_review_hash: "opaque-review",
            },
          };
        } else {
          assert.equal(arguments_.operation.transition_token, "opaque-transition");
          assert.equal(arguments_.operation.relation_disposition, "reviewed_none");
          assert.equal(arguments_.operation.relation_review_hash, "opaque-review");
          body = arguments_.operation.new_body;
          data = { path: arguments_.path, warnings: [] };
        }
      } else {
        assert.equal(message.params.name, "read_memory");
        data = {
          path: arguments_.path,
          body: options.mismatch ? "old nonce" : body,
          frontmatter: {},
          content_hash: "source-hash",
          mtime: 0,
        };
      }
      result = {
        content: [{ type: "text", text: "success" }],
        isError: false,
        ...(options.missingStructured ? {} : { structuredContent: data }),
      };
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config: MemoryHealthConfig = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    bearer: "isolated-cell-bearer",
    page: "Knowledge Base/Notes/Insights/synthetic-health.md",
    bodyTemplate:
      "## Observations\n\n- [operating constraint] Synthetic nonce: {{nonce}}. #health ^proof\n",
    timeoutMs: 1000,
  };
  return {
    config,
    operations,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

describe("memory functional proof at the MCP boundary", () => {
  it("uses the exact preflight proof for a fresh write/read without publishing content", async () => {
    const cell = await syntheticCell();
    try {
      assert.equal(await proveMemoryRoundTrip(cell.config), true);
      assert.equal(cell.operations.length, 2);
      assert.equal(cell.operations[0].new_body, cell.operations[1].new_body);
      assert.ok(!String(cell.operations[1].new_body).includes("{{nonce}}"));
    } finally {
      await cell.close();
    }
  });

  it("fails when a responding cell returns an older nonce", async () => {
    const cell = await syntheticCell({ mismatch: true });
    try {
      assert.equal(await proveMemoryRoundTrip(cell.config), false);
    } finally {
      await cell.close();
    }
  });

  it("rejects success text without the kernel's structured envelope before writing", async () => {
    const cell = await syntheticCell({ missingStructured: true });
    try {
      await assert.rejects(proveMemoryRoundTrip(cell.config));
      assert.equal(cell.operations.length, 1);
    } finally {
      await cell.close();
    }
  });

  it("aborts a stalled provider connection at the total budget without a retry", async () => {
    const cell = await syntheticCell({ hang: true });
    try {
      const started = performance.now();
      await assert.rejects(proveMemoryRoundTrip({ ...cell.config, timeoutMs: 100 }));
      assert.ok(performance.now() - started < 600);
      assert.equal(cell.requests(), 1);
    } finally {
      await cell.close();
    }
  });

  it(
    "writes and reads the real isolated pinned kernel",
    { skip: !process.env.EXOMEM_HEALTH_TEST_CELL_CONFIG },
    async () => {
      const config = JSON.parse(
        await readFile(process.env.EXOMEM_HEALTH_TEST_CELL_CONFIG!, "utf8")
      ) as MemoryHealthConfig;
      assert.equal(new URL(config.url).hostname, "127.0.0.1");
      assert.equal(await proveMemoryRoundTrip(config), true);
    }
  );
});
