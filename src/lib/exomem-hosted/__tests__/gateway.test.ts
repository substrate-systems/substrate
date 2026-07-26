import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { GatewayTarget } from "../db";
import { ExomemHostedError } from "../errors";
import {
  clearContractCacheForTests,
  hasForbiddenGatewayHeaders,
  hasReservedSelector,
  routeExomemCommand,
} from "../gateway";
import { SensitiveSecret, type SecretEnvelope } from "../security";
import canonicalContractFixture from "./gateway-contract-0-24-0.json";

const USER_A = "018f2d91-7c42-7000-8000-000000000071";
const TENANT_A = "018f2d91-7c42-7000-8000-000000000072";
const USER_B = "018f2d91-7c42-7000-8000-000000000073";
const TENANT_B = "018f2d91-7c42-7000-8000-000000000074";

// Generated from Exomem 0.24.0 commit 049d83c13e94102482a0f939c3baf065ee630fd1.
const CANONICAL_CONTRACT = canonicalContractFixture as TestContract;

type TestContract = {
  schema_version: number;
  protocol_version: string;
  exomem_release: string;
  commands: Array<{
    name: string;
    params: Array<{ name: string; type: string; required: boolean }>;
    read_only: boolean;
    mode: "read" | "write";
    tier: number;
    capability: string;
    guarded_fields: string[];
  }>;
  digest: { algorithm: "sha256"; value: string };
  [key: string]: unknown;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function contract(tamperDigest = false): TestContract {
  const value = structuredClone(CANONICAL_CONTRACT);
  if (tamperDigest) value.digest.value = "0".repeat(64);
  return value;
}

function alteredContract(mutate: (value: TestContract) => void): TestContract {
  const value = contract();
  mutate(value);
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  value.digest.value = createHash("sha256")
    .update(JSON.stringify(canonicalize(unsigned)))
    .digest("hex");
  return value;
}

function target(input: {
  userId: string;
  tenantId: string;
  cellId: string;
  endpoint: string;
  capabilities?: string[];
}): GatewayTarget {
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    tenantStatus: "active",
    tenantDesiredState: "running",
    cellId: input.cellId,
    cellLifecycleState: "active",
    cellRoutingState: "bound",
    protocolVersion: "1",
    releaseVersion: "0.24.0",
    credentialVersion: 1,
    credentialCiphertext: { value: `credential-${input.cellId}` },
    endpointCiphertext: { value: input.endpoint },
    entitlementSource: "complimentary",
    entitlementSourceState: "complimentary_active",
    entitlementEffectiveState: "active",
    capabilities: input.capabilities ?? ["capture", "recall", "export"],
    resourceLimits: {
      storageBytes: 1024,
      uploadBytes: 512,
      workerCount: 0,
    },
    manuallySuspended: false,
  };
}

function decrypt(envelope: SecretEnvelope): SensitiveSecret {
  return new SensitiveSecret(String((envelope as unknown as { value: string }).value));
}

beforeEach(clearContractCacheForTests);

describe("registry-derived Exomem gateway", () => {
  it("rejects browser attempts to supply Cloudflare Access service credentials", () => {
    for (const name of ["CF-Access-Client-Id", "CF-Access-Client-Secret"]) {
      assert.equal(hasForbiddenGatewayHeaders(new Headers({ [name]: "browser-value" })), true);
    }
  });

  it("keeps identical paths and idempotency keys isolated to the mapped cell", async () => {
    const targets = new Map([
      [
        TENANT_A,
        target({
          userId: USER_A,
          tenantId: TENANT_A,
          cellId: "cell-a",
          endpoint: "https://cell-a.internal/",
        }),
      ],
      [
        TENANT_B,
        target({
          userId: USER_B,
          tenantId: TENANT_B,
          cellId: "cell-b",
          endpoint: "https://cell-b.internal/",
        }),
      ],
    ]);
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (url.endsWith("/contract")) return Response.json(contract());
      const cell = new URL(url).hostname.startsWith("cell-a") ? "cell-a" : "cell-b";
      return Response.json({ success: true, data: { cell } });
    };
    const resolveTarget = async (session: { tenantId: string }) =>
      targets.get(session.tenantId) ?? null;
    const access = {
      selectedVersion: "active" as const,
      active: {
        clientId: new SensitiveSecret("gateway-client-id.access"),
        clientSecret: new SensitiveSecret("gateway-client-secret-sentinel"),
      },
      previous: null,
    };

    const first = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Same", content: "same path" },
      idempotencyKey: "same-public-key",
      dependencies: {
        resolveTarget,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
        access,
      },
    });
    const second = await routeExomemCommand({
      session: { userId: USER_B, tenantId: TENANT_B },
      commandName: "remember",
      args: { title: "Same", content: "same path" },
      idempotencyKey: "same-public-key",
      dependencies: {
        resolveTarget,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "B".repeat(43),
        access,
      },
    });

    assert.deepEqual(first.body, { success: true, data: { cell: "cell-a" } });
    assert.deepEqual(second.body, { success: true, data: { cell: "cell-b" } });
    const commandCalls = calls.filter((call) => call.url.includes("/command/"));
    assert.equal(commandCalls.length, 2);
    assert.match(commandCalls[0].url, /\/private\/exomem\/v1\/command\//);
    assert.equal(commandCalls[0].headers.get("x-exomem-cell-id"), "cell-a");
    assert.equal(commandCalls[1].headers.get("x-exomem-cell-id"), "cell-b");
    assert.equal(commandCalls[0].headers.get("idempotency-key"), "same-public-key");
    assert.equal(commandCalls[1].headers.get("idempotency-key"), "same-public-key");
    assert.equal(commandCalls[0].headers.get("cf-access-client-id"), "gateway-client-id.access");
    assert.equal(
      commandCalls[0].headers.get("cf-access-client-secret"),
      "gateway-client-secret-sentinel"
    );
    assert.notEqual(
      commandCalls[0].headers.get("x-exomem-principal-scope"),
      commandCalls[1].headers.get("x-exomem-principal-scope")
    );
  });

  it("rejects nested routing selectors before resolving or contacting a cell", async () => {
    let resolutions = 0;
    let calls = 0;
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: {
          title: "selector",
          content: "safe",
          metadata: { tenant_id: TENANT_B },
        },
        idempotencyKey: "selector-test",
        dependencies: {
          resolveTarget: async () => {
            resolutions += 1;
            return null;
          },
          fetch: async () => {
            calls += 1;
            return Response.json({});
          },
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "HOSTED_SELECTOR_REJECTED"
    );
    assert.equal(resolutions, 0);
    assert.equal(calls, 0);
  });

  it("normalizes camel-case authority selectors", () => {
    assert.equal(hasReservedSelector({ tenantId: TENANT_A }), true);
    assert.equal(hasReservedSelector({ nested: { cellId: "cell-a" } }), true);
    assert.equal(hasReservedSelector({ auth: { sessionId: "other" } }), true);
  });

  it("retries a lost mutation acknowledgement only against the same cell", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let commandCalls = 0;
    const seenHeaders: Headers[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/contract")) return Response.json(contract());
      commandCalls += 1;
      seenHeaders.push(new Headers(init?.headers));
      if (commandCalls === 1) throw new Error("lost acknowledgement");
      return Response.json({ success: true, data: { replayed: true } });
    };
    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Retry", content: "once" },
      idempotencyKey: "retry-once",
      dependencies: {
        resolveTarget: async () => row,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    assert.equal(commandCalls, 2);
    assert.deepEqual(result.body, { success: true, data: { replayed: true } });
    assert.equal(
      seenHeaders[0].get("x-exomem-request-id"),
      seenHeaders[1].get("x-exomem-request-id")
    );
    assert.equal(seenHeaders[0].get("idempotency-key"), "retry-once");
  });

  it("retries a reset 200 response body against the same cell and request identity", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let commandCalls = 0;
    const seenHeaders: Headers[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/contract")) return Response.json(contract());
      commandCalls += 1;
      seenHeaders.push(new Headers(init?.headers));
      if (commandCalls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("stream reset after headers"));
            },
          }),
          { status: 200 }
        );
      }
      return Response.json({ success: true, data: { replayed: true } });
    };

    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Retry", content: "lost body acknowledgement" },
      idempotencyKey: "retry-reset-body",
      dependencies: {
        resolveTarget: async () => row,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });

    assert.deepEqual(result.body, { success: true, data: { replayed: true } });
    assert.equal(commandCalls, 2);
    assert.equal(
      seenHeaders[0].get("x-exomem-request-id"),
      seenHeaders[1].get("x-exomem-request-id")
    );
    assert.equal(seenHeaders[1].get("idempotency-key"), "retry-reset-body");
  });

  it("does not retry a malformed successful command envelope", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let commandCalls = 0;

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "invalid response is not transport failure" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) => {
            if (String(input).endsWith("/contract")) return Response.json(contract());
            commandCalls += 1;
            return new Response("not json", { status: 200 });
          },
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );
    assert.equal(commandCalls, 1);
  });

  it("does not begin a retry after the command's absolute deadline", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let now = 0;
    let commandCalls = 0;

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "one bounded deadline" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) => {
            if (String(input).endsWith("/contract")) return Response.json(contract());
            commandCalls += 1;
            now = 10_001;
            throw new Error("deadline consumed");
          },
          expectedProtocol: "1",
          now: () => now,
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) => error instanceof ExomemHostedError && error.code === "CELL_UNAVAILABLE"
    );
    assert.equal(commandCalls, 1);
  });

  it("stops reading an oversized streamed command response at the configured bound", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let pulls = 0;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 128) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "bounded response" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contract())
              : new Response(oversized, { status: 200 }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 66, `read ${pulls} chunks after crossing the 4 MiB bound`);
  });

  it("cancels a retryable error body without draining an unbounded stream", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let pulls = 0;
    let cancelled = false;
    let commandCalls = 0;
    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith("/contract")) return Response.json(contract());
      commandCalls += 1;
      if (commandCalls === 2) return Response.json({ success: true, data: { replayed: true } });
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(chunk);
            if (pulls === 128) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 }
      );
    };

    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Retry", content: "bounded error body" },
      idempotencyKey: "bounded-error-body",
      dependencies: {
        resolveTarget: async () => row,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    assert.deepEqual(result.body, { success: true, data: { replayed: true } });
    assert.equal(commandCalls, 2);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `drained ${pulls} chunks before retrying`);
  });

  it("cancels an unsuccessful contract body without draining an unbounded stream", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let pulls = 0;
    let cancelled = false;
    const unbounded = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "bounded contract error" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async () => new Response(unbounded, { status: 503 }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) => error instanceof ExomemHostedError && error.code === "CELL_UNAVAILABLE"
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `drained ${pulls} contract chunks before failing closed`);
  });

  it("fails closed for a tampered contract and absent capabilities", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
      capabilities: ["recall"],
    });
    const dependencies = {
      resolveTarget: async () => row,
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "anything" },
        dependencies: {
          ...dependencies,
          fetch: async () => Response.json(contract(true)),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );

    clearContractCacheForTests();
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: { title: "Denied", content: "no capture" },
        idempotencyKey: "denied-write",
        dependencies: {
          ...dependencies,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contract())
              : Response.json({ success: true, data: {} }),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
  });

  it("rejects contradictory read metadata before using it for retry or mutation policy", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const contradictory = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "ask_memory");
      assert.ok(command);
      command.read_only = false;
    });

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "anything" },
        idempotencyKey: "contradictory-read-mode",
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contradictory)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );
  });

  it("rejects self-consistent semantic drift from the pinned 0.24.0 registry", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const drifted = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "remember");
      assert.ok(command);
      command.guarded_fields = [];
    });
    assert.notEqual(
      drifted.digest.value,
      "b760214e79b4f9819757609ec7c6a6be74762e7b675680aa91e8386dd71ee32d"
    );

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: { title: "Drift", content: "must not execute" },
        idempotencyKey: "semantic-drift",
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(drifted)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
  });

  it("does not let a cached contract hide an immediately altered digest", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let contractCalls = 0;
    let commandCalls = 0;
    const drifted = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "ask_memory");
      assert.ok(command);
      command.capability = "unexpected-capability";
    });
    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith("/contract")) {
        contractCalls += 1;
        return Response.json(contractCalls === 1 ? contract() : drifted);
      }
      commandCalls += 1;
      return Response.json({ success: true, data: {} });
    };
    const dependencies = {
      resolveTarget: async () => row,
      fetch: fetchMock,
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };

    await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "ask_memory",
      args: { query: "first" },
      dependencies,
    });
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "second" },
        dependencies,
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
    assert.equal(contractCalls, 2);
    assert.equal(commandCalls, 1);
  });

  it("keeps adoption_studio on generic dispatch while transfer verbs stay intercepted", async () => {
    let resolutions = 0;
    const dependencies = {
      resolveTarget: async () => {
        resolutions += 1;
        return null;
      },
      fetch: async () => Response.json({}),
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };

    for (const commandName of ["transfer_artifact", "adopt_vault"]) {
      await assert.rejects(
        routeExomemCommand({
          session: { userId: USER_A, tenantId: TENANT_A },
          commandName,
          args: {},
          idempotencyKey: "intercept-check",
          dependencies,
        }),
        (error: unknown) =>
          error instanceof ExomemHostedError && error.code === "HOSTED_INTERCEPT_REQUIRED"
      );
    }
    assert.equal(resolutions, 0);

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "adoption_studio",
        args: { action: "status", run_id: "run-1" },
        idempotencyKey: "generic-dispatch-check",
        dependencies,
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_MAPPING_MISSING"
    );
    assert.equal(resolutions, 1);
  });
});
