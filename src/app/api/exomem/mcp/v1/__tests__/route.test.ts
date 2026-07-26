import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

const lines: string[] = [];

before(() => {
  mock.module("@/lib/exomem-hosted/mcp", {
    namedExports: {
      handleHostedMcpRequest: async (
        _request: Request,
        dependencies: { telemetry?: (event: Record<string, unknown>) => void }
      ) => {
        dependencies.telemetry?.({ event: "mcp.request", outcome: "denied" });
        return new Response(null, { status: 401 });
      },
    },
  });
});

after(() => mock.reset());

describe("POST /api/exomem/mcp/v1", () => {
  it("sends the real route's content-free operational event through its production sink", async () => {
    const observability = await import("@/lib/exomem-hosted/observability");
    observability.setOperationalEventSinkForTests((line) => lines.push(line));
    try {
      const { POST } = await import("../route");
      const response = await POST(
        new Request("https://substratesystems.io/api/exomem/mcp/v1", { method: "POST" })
      );
      assert.equal(response.status, 401);
      assert.deepEqual(
        lines.map((line) => JSON.parse(line)),
        [
          {
            timestamp: JSON.parse(lines[0]).timestamp,
            event: "mcp.request",
            outcome: "denied",
          },
        ]
      );
    } finally {
      observability.setOperationalEventSinkForTests(null);
      lines.length = 0;
    }
  });
});
