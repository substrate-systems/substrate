import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GatewayTarget } from "../db";
import { SensitiveSecret, type SecretEnvelope } from "../security";
import { createDirectTransferTicket, mintCellTransferGrant } from "../transfers";

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
    credentialVersion: 1,
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
  it("matches the Exomem cell's exact canonical transfer-v2 HMAC vector", () => {
    const result = mintCellTransferGrant({
      credential: new SensitiveSecret("c".repeat(32)),
      credentialVersion: "1",
      origin: "https://substratesystems.io",
      cellId: "cell-alpha",
      principalScope: "A".repeat(43),
      operation: "upload",
      jti: "123e4567-e89b-42d3-a456-426614174000",
      maxBytes: 500,
      issuedAt: 1_700_000_000,
      ttlSeconds: 300,
      target: {
        kind: "upload-v1",
        metadata: {
          category: "uploads",
          content_type: "text/plain",
          description: null,
          filename: "proof.txt",
          scope: "inbox",
          sha256: "a".repeat(64),
          size: 10,
        },
        metadata_sha256: "01540ccdb23d5d295bcb3f4fd780eabe868605d45db4b1b51e49f5907e07b1d2",
      },
    });
    assert.equal(
      result.token,
      "eyJhdWQiOiJleG9tZW0taG9zdGVkLXRyYW5zZmVyIiwiY2VsbCI6ImNlbGwtYWxwaGEiLCJleHAiOjE3MDAwMDAzMDAsImlhdCI6MTcwMDAwMDAwMCwianRpIjoiMTIzZTQ1NjctZTg5Yi00MmQzLWE0NTYtNDI2NjE0MTc0MDAwIiwia2lkIjoiMSIsImxpbWl0cyI6eyJtYXhfYnl0ZXMiOjUwMH0sIm1ldGhvZCI6IlBVVCIsIm5iZiI6MTcwMDAwMDAwMCwib3AiOiJ1cGxvYWQiLCJvcmlnaW4iOiJodHRwczovL3N1YnN0cmF0ZXN5c3RlbXMuaW8iLCJwcmluY2lwYWwiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwidGFyZ2V0Ijp7ImtpbmQiOiJ1cGxvYWQtdjEiLCJtZXRhZGF0YSI6eyJjYXRlZ29yeSI6InVwbG9hZHMiLCJjb250ZW50X3R5cGUiOiJ0ZXh0L3BsYWluIiwiZGVzY3JpcHRpb24iOm51bGwsImZpbGVuYW1lIjoicHJvb2YudHh0Iiwic2NvcGUiOiJpbmJveCIsInNoYTI1NiI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJzaXplIjoxMH0sIm1ldGFkYXRhX3NoYTI1NiI6IjAxNTQwY2NkYjIzZDVkMjk1YmNiM2Y0ZmQ3ODBlYWJlODY4NjA1ZDQ1ZGI0YjFiNTFlNDlmNTkwN2UwN2IxZDIifSwidiI6Mn0.8OUw83u4cRmv9iLpH7jO3YLaoEMRX88K6cuPqIaB4Ow"
    );
    assert.equal(result.expiresAt, 1_700_000_300);
  });

  it("rejects a 43-character principal that is not canonical 32-byte base64url", () => {
    assert.throws(
      () =>
        mintCellTransferGrant({
          credential: new SensitiveSecret("c".repeat(32)),
          credentialVersion: "1",
          origin: "https://substratesystems.io",
          cellId: "cell-alpha",
          principalScope: "B".repeat(43),
          operation: "download",
          jti: "123e4567-e89b-42d3-a456-426614174000",
          maxBytes: 500,
          issuedAt: 1_700_000_000,
          target: { kind: "download-v1", path: "Evidence/proof.txt" },
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_REQUEST"
    );
  });

  for (const origin of ["http://localhost:3000", `https://${"a".repeat(244)}.example`]) {
    it(`rejects non-canonical transfer origin ${origin.slice(0, 40)}`, () => {
      assert.throws(
        () =>
          mintCellTransferGrant({
            credential: new SensitiveSecret("c".repeat(32)),
            credentialVersion: "1",
            origin,
            cellId: "cell-alpha",
            principalScope: "A".repeat(43),
            operation: "download",
            jti: "123e4567-e89b-42d3-a456-426614174000",
            maxBytes: 500,
            issuedAt: 1_700_000_000,
            target: { kind: "download-v1", path: "Evidence/proof.txt" },
          }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "INVALID_REQUEST"
      );
    });
  }

  it("records a one-cell grant and returns only a direct public transfer ticket", async () => {
    const events: string[] = [];
    const transfer = await createDirectTransferTicket({
      session: { userId: USER_ID, tenantId: TENANT_ID },
      request: {
        operation: "upload",
        metadata: {
          category: "uploads",
          content_type: "text/plain",
          description: null,
          filename: "proof.txt",
          scope: "inbox",
          sha256: "a".repeat(64),
          size: 10,
        },
      },
      dependencies: {
        resolveTarget: async () => target(),
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
        now: () => 1_700_000_000_000,
        randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
        publicOrigin: "https://substratesystems.io",
        transferHost: "transfer.example.test",
        createGrant: async (input) => {
          events.push(`create:${input.tenantId}:${input.cellId}:${input.operation}`);
          assert.equal(input.byteLimit, 500);
          assert.equal(input.grantDigest.length, 32);
          assert.equal(input.principalScopeDigest.length, 32);
          return { grantId: "grant-row-1" };
        },
      },
    });

    assert.deepEqual(events, [`create:${TENANT_ID}:cell-alpha:upload`]);
    assert.equal(transfer.maxBytes, 500);
    assert.equal(
      transfer.url,
      "https://transfer.example.test/cells/cell-alpha/public/exomem/v2/transfers/upload"
    );
    assert.equal(transfer.method, "PUT");
    assert.equal(transfer.headers["Content-Type"], "text/plain");
    assert.equal(transfer.headers["X-Exomem-Transfer-Grant"]?.includes("cell-alpha"), false);
    assert.equal(transfer.headers["X-Exomem-Transfer-Grant"]?.includes("c".repeat(32)), false);
  });

  it("fails closed when ticket issuance cannot be durably recorded", async () => {
    await assert.rejects(
      createDirectTransferTicket({
        session: { userId: USER_ID, tenantId: TENANT_ID },
        request: { operation: "download", path: "Evidence/proof.txt" },
        dependencies: {
          resolveTarget: async () => target(),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
          publicOrigin: "https://substratesystems.io",
          transferHost: "transfer.example.test",
          createGrant: async () => null,
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CELL_UNAVAILABLE"
    );
  });

  it("fails closed on a non-positive durable credential version", async () => {
    await assert.rejects(
      createDirectTransferTicket({
        session: { userId: USER_ID, tenantId: TENANT_ID },
        request: { operation: "download", path: "Evidence/proof.txt" },
        dependencies: {
          resolveTarget: async () => ({ ...target(), credentialVersion: 0 }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
          publicOrigin: "https://substratesystems.io",
          transferHost: "transfer.example.test",
          createGrant: async () => ({ grantId: "must-not-be-created" }),
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CELL_UNAVAILABLE"
    );
  });

  it("enforces exact upload metadata and the 90 MiB hosted cap", async () => {
    const largeTarget = {
      ...target(),
      resourceLimits: {
        storageBytes: 5 * 1024 * 1024 * 1024,
        uploadBytes: 200 * 1024 * 1024,
        workerCount: 0,
      },
    };
    const dependencies = {
      resolveTarget: async () => largeTarget,
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
      publicOrigin: "https://substratesystems.io",
      transferHost: "transfer.example.test",
      createGrant: async () => ({ grantId: "grant-row-1" }),
    };
    const metadata = {
      category: null,
      content_type: "application/octet-stream",
      description: null,
      filename: "archive.bin",
      scope: null,
      sha256: "a".repeat(64),
      size: 90 * 1024 * 1024,
    };

    const accepted = await createDirectTransferTicket({
      session: { userId: USER_ID, tenantId: TENANT_ID },
      request: { operation: "upload", metadata },
      dependencies,
    });
    assert.equal(accepted.maxBytes, 90 * 1024 * 1024);

    await assert.rejects(
      createDirectTransferTicket({
        session: { userId: USER_ID, tenantId: TENANT_ID },
        request: {
          operation: "upload",
          metadata: { ...metadata, size: 90 * 1024 * 1024 + 1 },
        },
        dependencies,
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_REQUEST"
    );
  });

  for (const path of [
    "/absolute.txt",
    "Evidence/../secret.txt",
    "Evidence//proof.txt",
    "Evidence/\ud800.txt",
  ]) {
    it(`rejects non-normalized download path ${path}`, async () => {
      await assert.rejects(
        createDirectTransferTicket({
          session: { userId: USER_ID, tenantId: TENANT_ID },
          request: { operation: "download", path },
          dependencies: {
            resolveTarget: async () => target(),
            expectedProtocol: "1",
            decrypt,
            principalScope: () => "A".repeat(43),
            publicOrigin: "https://substratesystems.io",
            transferHost: "transfer.example.test",
            createGrant: async () => ({ grantId: "must-not-be-created" }),
          },
        }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "INVALID_REQUEST"
      );
    });
  }

  it("binds adoption staging uploads into the locked upload-v1 metadata fields", async () => {
    const dependencies = {
      resolveTarget: async () => target(),
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
      publicOrigin: "https://substratesystems.io",
      transferHost: "transfer.example.test",
      createGrant: async () => ({ grantId: "grant-row-1" }),
    };

    const zipped = await createDirectTransferTicket({
      session: { userId: USER_ID, tenantId: TENANT_ID },
      request: {
        operation: "adoption-upload",
        metadata: {
          content_type: "application/zip",
          filename: "notes.zip",
          path: "inbox/deep",
          run_id: "run_2026-07-16",
          sha256: "a".repeat(64),
          size: 10,
        },
      },
      dependencies,
    });
    assert.equal(
      zipped.url,
      "https://transfer.example.test/cells/cell-alpha/public/exomem/v2/transfers/upload"
    );
    assert.equal(zipped.method, "PUT");
    assert.equal(zipped.headers["Content-Type"], "application/zip");
    const claims = JSON.parse(
      Buffer.from(zipped.headers["X-Exomem-Transfer-Grant"].split(".")[0], "base64url").toString(
        "utf8"
      )
    ) as { op: string; target: { kind: string; metadata: Record<string, unknown> } };
    assert.equal(claims.op, "upload");
    assert.equal(claims.target.kind, "upload-v1");
    assert.deepEqual(claims.target.metadata, {
      category: "run_2026-07-16",
      content_type: "application/zip",
      description: "inbox/deep",
      filename: "notes.zip",
      scope: "adoption-staging",
      sha256: "a".repeat(64),
      size: 10,
    });

    const single = await createDirectTransferTicket({
      session: { userId: USER_ID, tenantId: TENANT_ID },
      request: {
        operation: "adoption-upload",
        metadata: {
          content_type: "text/markdown",
          filename: "note.md",
          path: null,
          run_id: "run-1",
          sha256: "b".repeat(64),
          size: 10,
        },
      },
      dependencies,
    });
    const singleClaims = JSON.parse(
      Buffer.from(single.headers["X-Exomem-Transfer-Grant"].split(".")[0], "base64url").toString(
        "utf8"
      )
    ) as { target: { metadata: Record<string, unknown> } };
    assert.equal(singleClaims.target.metadata.scope, "adoption-staging");
    assert.equal(singleClaims.target.metadata.category, "run-1");
    assert.equal(singleClaims.target.metadata.description, null);
  });

  it("rejects adoption staging metadata with a bad run id, path, size, or shape", async () => {
    const dependencies = {
      resolveTarget: async () => target(),
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
      publicOrigin: "https://substratesystems.io",
      transferHost: "transfer.example.test",
      createGrant: async () => ({ grantId: "must-not-be-created" }),
    };
    const metadata = {
      content_type: "text/markdown",
      filename: "note.md",
      path: null as string | null,
      run_id: "run-1",
      sha256: "a".repeat(64),
      size: 10,
    };
    const invalidRequests = [
      ...["", ".", "..", "run 1", "run/1", "-run", `r${"u".repeat(64)}`].map((runId) => ({
        ...metadata,
        run_id: runId,
      })),
      ...["/abs", "a//b", "a/../b", "a\\b", ".", "..", "x/", "", "a/"].map((path) => ({
        ...metadata,
        path,
      })),
      // Over the tenant's 500-byte uploadBytes allowance.
      { ...metadata, size: 501 },
      // The staging fields are composed server-side, never caller-supplied.
      { ...metadata, scope: "adoption-staging" } as unknown as typeof metadata,
      { ...metadata, category: "run-1" } as unknown as typeof metadata,
    ];

    for (const invalid of invalidRequests) {
      await assert.rejects(
        createDirectTransferTicket({
          session: { userId: USER_ID, tenantId: TENANT_ID },
          request: { operation: "adoption-upload", metadata: invalid },
          dependencies,
        }),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "INVALID_REQUEST",
        `expected rejection for ${JSON.stringify(invalid)}`
      );
    }
  });

  it("rejects upload metadata containing an unpaired Unicode surrogate", async () => {
    await assert.rejects(
      createDirectTransferTicket({
        session: { userId: USER_ID, tenantId: TENANT_ID },
        request: {
          operation: "upload",
          metadata: {
            category: null,
            content_type: "text/plain",
            description: null,
            filename: "\ud800.txt",
            scope: null,
            sha256: "a".repeat(64),
            size: 1,
          },
        },
        dependencies: {
          resolveTarget: async () => target(),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
          publicOrigin: "https://substratesystems.io",
          transferHost: "transfer.example.test",
          createGrant: async () => ({ grantId: "must-not-be-created" }),
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_REQUEST"
    );
  });
});
