import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

let routedCommands: Array<{
  commandName: string;
  args: Record<string, unknown>;
  idempotencyKey: string | null | undefined;
}> = [];

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({
        id: "session-1",
        userId: "018f2d91-7c42-7000-8000-000000000091",
        tenantId: "018f2d91-7c42-7000-8000-000000000092",
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-16T00:00:00.000Z",
      }),
      validateMutationRequest: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/gateway", {
    namedExports: {
      gatewayLimits: { commandBytes: 1024 * 1024 },
      hasForbiddenGatewayHeaders: () => false,
      hasReservedSelector: () => false,
      routeExomemCommand: async (input: {
        commandName: string;
        args: Record<string, unknown>;
        idempotencyKey?: string | null;
      }) => {
        routedCommands.push({
          commandName: input.commandName,
          args: input.args,
          idempotencyKey: input.idempotencyKey,
        });
        return { status: 200, body: { success: true, data: { run_id: "run-1" } } };
      },
    },
  });
});

after(() => mock.reset());

describe("POST /api/exomem/commands/adoption_studio", () => {
  it("forwards adoption_studio through generic dispatch with its retry key", async () => {
    routedCommands = [];
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../[command]/route");
    const args = { action: "start", path: "_Staging/adoption/run-1", initialize_kb: false };
    const request = new NextRequest(
      "https://substratesystems.io/api/exomem/commands/adoption_studio",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "retry-start",
          "x-exomem-csrf": "csrf",
        },
        body: JSON.stringify(args),
      }
    );

    const response = await POST(request, {
      params: Promise.resolve({ command: "adoption_studio" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(routedCommands, [
      { commandName: "adoption_studio", args, idempotencyKey: "retry-start" },
    ]);
    assert.deepEqual(await response.json(), { success: true, data: { run_id: "run-1" } });
  });
});
