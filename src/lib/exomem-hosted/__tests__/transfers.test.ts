import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GatewayTarget } from "../db";
import { SensitiveSecret, type SecretEnvelope } from "../security";
import { createBoundTransfer, mintCellTransferGrant, readBoundedTransferJson } from "../transfers";

const USER_ID = "018f2d91-7c42-7000-8000-000000000081";
const TENANT_ID = "018f2d91-7c42-7000-8000-000000000082";

function target(): GatewayTarget {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    tenantStatus: "active",
    tenantDesiredState: "running",
    cellId: "cell-alpha",
    cellLifecycleState: "active",
    cellRoutingState: "bound",
    protocolVersion: "1",
    releaseVersion: "1.2.3",
    credentialCiphertext: { value: "c".repeat(32) },
    endpointCiphertext: { value: "https://cell-alpha.internal/" },
    entitlementSource: "complimentary",
    entitlementSourceState: "complimentary_active",
    entitlementEffectiveState: "active",
    capabilities: ["capture", "recall", "export"],
    resourceLimits: { storageBytes: 1000, uploadBytes: 500, workerCount: 0 },
    manuallySuspended: false,
  };
}

function decrypt(envelope: SecretEnvelope): SensitiveSecret {
  return new SensitiveSecret(String((envelope as unknown as { value: string }).value));
}

describe("tenant-bound Exomem transfers", () => {
  it("bounds a chunked cell JSON response before buffering the whole body", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":true,"data":"'));
          controller.enqueue(new Uint8Array(64));
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    await assert.rejects(
      readBoundedTransferJson(response, 32, 100),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CELL_RESPONSE_INVALID"
    );
    assert.equal(cancelled, true);
  });

  it("cancels a cell JSON response that goes idle", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    await assert.rejects(
      readBoundedTransferJson(response, 1024, 5),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CELL_UNAVAILABLE"
    );
    assert.equal(cancelled, true);
  });

  it("parses a bounded chunked cell JSON response", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":'));
          controller.enqueue(new TextEncoder().encode('true,"data":{"ok":true}}'));
          controller.close();
        },
      })
    );

    assert.deepEqual(await readBoundedTransferJson(response, 1024, 100), {
      success: true,
      data: { ok: true },
    });
  });

  it("matches the Exomem cell's canonical HMAC grant vector", () => {
    const result = mintCellTransferGrant({
      credential: new SensitiveSecret("c".repeat(32)),
      tenantId: "tenant-alpha",
      cellId: "cell-alpha",
      principalScope: "A".repeat(43),
      operation: "upload",
      jti: "grant-1",
      maxBytes: 500,
      issuedAt: 1_700_000_000,
      ttlSeconds: 300,
    });
    assert.equal(
      result.token,
      "eyJhdWQiOiJleG9tZW0taG9zdGVkLXRyYW5zZmVyIiwiY2VsbCI6ImNlbGwtYWxwaGEiLCJleHAiOjE3MDAwMDAzMDAsImlhdCI6MTcwMDAwMDAwMCwianRpIjoiZ3JhbnQtMSIsImxpbWl0cyI6eyJtYXhfYnl0ZXMiOjUwMH0sIm9wIjoidXBsb2FkIiwicHJpbmNpcGFsIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsInRlbmFudCI6InRlbmFudC1hbHBoYSIsInYiOjF9.PFReQTa0qowqrqwcS-iFKXEPNLCmmRw7_orbR_bCFlY"
    );
    assert.equal(result.expiresAt, 1_700_000_300);
  });

  it("persists and consumes a one-cell grant before returning forwarding authority", async () => {
    const events: string[] = [];
    const transfer = await createBoundTransfer({
      session: { userId: USER_ID, tenantId: TENANT_ID },
      operation: "upload",
      dependencies: {
        resolveTarget: async () => target(),
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
        now: () => 1_700_000_000_000,
        createGrant: async (input) => {
          events.push(`create:${input.tenantId}:${input.cellId}:${input.operation}`);
          assert.equal(input.byteLimit, 500);
          assert.equal(input.grantDigest.length, 32);
          assert.equal(input.principalScopeDigest.length, 32);
          return { grantId: "grant-row-1" };
        },
        consumeGrant: async (input) => {
          events.push(`consume:${input.tenantId}:${input.cellId}:${input.operation}`);
          return true;
        },
      },
    });

    assert.deepEqual(events, [
      `create:${TENANT_ID}:cell-alpha:upload`,
      `consume:${TENANT_ID}:cell-alpha:upload`,
    ]);
    assert.equal(transfer.maxBytes, 500);
    assert.equal(transfer.target.row.tenantId, TENANT_ID);
    assert.equal(transfer.grant.includes("cell-alpha"), false);
    assert.equal(transfer.grant.includes("c".repeat(32)), false);
    assert.equal(transfer.target.endpoint.toString(), "https://cell-alpha.internal/");
  });

  it("fails closed when the single-use grant cannot be consumed", async () => {
    await assert.rejects(
      createBoundTransfer({
        session: { userId: USER_ID, tenantId: TENANT_ID },
        operation: "download",
        dependencies: {
          resolveTarget: async () => target(),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
          createGrant: async () => ({ grantId: "grant-row-1" }),
          consumeGrant: async () => false,
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CELL_UNAVAILABLE"
    );
  });
});
