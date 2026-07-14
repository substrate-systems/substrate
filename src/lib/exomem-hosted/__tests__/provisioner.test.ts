import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  FakeCellProvisioner,
  HttpCellProvisioner,
  ProvisionerFailure,
  ProvisionerPending,
  provisionerConfigFromEnv,
  type CreateExportRequest,
  type ProvisionCellRequest,
} from "../provisioner";
import { SensitiveSecret } from "../security";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function provisionRequest(): ProvisionCellRequest {
  return {
    context: {
      operationId: "018f2d91-7c42-7000-8000-000000000041",
      checkpoint: "candidate-created",
      idempotencyKey: "018f2d91-7c42-7000-8000-000000000041:candidate-created",
      fenceGeneration: 1,
    },
    tenantId: "018f2d91-7c42-7000-8000-000000000042",
    cellId: "018f2d91-7c42-7000-8000-000000000043",
    protocolVersion: "1",
    releaseVersion: "2026.07.12",
    serviceCredential: new SensitiveSecret("credential-sensitive-sentinel"),
    workerPolicy: { workerCount: 0, semantic: false, media: false },
  };
}

describe("CellProvisioner", () => {
  it("converges duplicate provision calls to one deterministic fake cell", async () => {
    const fake = new FakeCellProvisioner();
    const request = provisionRequest();
    const first = await fake.provision(request);
    const second = await fake.provision(request);

    assert.deepEqual(second, first);
    assert.equal(fake.resources.size, 1);
    assert.equal(fake.calls.filter((call) => call.action === "provision").length, 2);
  });

  it("rejects one idempotency key reused with a different canonical payload", async () => {
    const fake = new FakeCellProvisioner();
    const request = provisionRequest();
    await fake.provision(request);

    await assert.rejects(
      fake.provision({ ...request, releaseVersion: "different-release" }),
      (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.equal(error.code, "PROVISIONER_REJECTED");
        assert.equal(error.retryable, false);
        return true;
      }
    );
    assert.equal(fake.resources.size, 1);
  });

  it("authenticates HTTP calls, scopes idempotency, and never serializes billing or email", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("provisioner-secret-sentinel"),
        timeoutMs: 500,
        access: {
          selectedVersion: "active",
          active: {
            clientId: new SensitiveSecret("access-client-id.access"),
            clientSecret: new SensitiveSecret("access-client-secret-sentinel"),
          },
          previous: null,
        },
      },
      async (input, init) => {
        captured = { url: String(input), init: init ?? {} };
        return Response.json({
          providerRef: "provider-opaque-1",
          privateEndpoint: "https://cell.internal.example",
        });
      }
    );

    await adapter.provision(provisionRequest());

    assert.equal(captured?.url, "https://provisioner.internal.example/v1/cells/provision");
    const headers = new Headers(captured?.init.headers);
    assert.equal(headers.get("authorization"), "Bearer provisioner-secret-sentinel");
    assert.equal(headers.get("cf-access-client-id"), "access-client-id.access");
    assert.equal(headers.get("cf-access-client-secret"), "access-client-secret-sentinel");
    assert.equal(
      headers.get("idempotency-key"),
      "018f2d91-7c42-7000-8000-000000000041:candidate-created"
    );
    const body = String(captured?.init.body);
    assert.equal(body.includes("credential-sensitive-sentinel"), true);
    assert.equal(body.includes("email"), false);
    assert.equal(body.toLowerCase().includes("paddle"), false);
  });

  it("binds export creation to one exact product expiry and forwards durable replays", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("provider-secret"),
        timeoutMs: 500,
      },
      async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          exportRef: "export-ref-1",
          releaseRef: "release-ref-1",
          archiveSha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
          archiveSize: 1024,
          encryptionScheme: "envelope-aes-256-gcm",
          integrityVerified: true,
        });
      }
    );
    const target = { ...provisionRequest(), providerRef: "provider-ref-1" };
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const request: CreateExportRequest = { ...target, expiresAt };

    await adapter.export(request);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.expiresAt, expiresAt.toISOString());

    await assert.rejects(
      adapter.export({ ...target, expiresAt: new Date("invalid") }),
      (error) =>
        error instanceof ProvisionerFailure && error.code === "PROVISIONER_CONFIGURATION_INVALID"
    );

    await assert.rejects(
      adapter.export({
        ...target,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 60_000),
      }),
      (error) =>
        error instanceof ProvisionerFailure && error.code === "PROVISIONER_CONFIGURATION_INVALID"
    );

    const expiredAt = new Date(Date.now() - 60_000);
    await assert.rejects(
      adapter.export({ ...target, expiresAt: expiredAt }),
      (error) =>
        error instanceof ProvisionerFailure && error.code === "PROVISIONER_CONFIGURATION_INVALID"
    );
    await adapter.export({
      ...target,
      context: {
        ...target.context,
        checkpoint: "export-requested",
        idempotencyKey: `${target.context.operationId}:export-requested`,
      },
      expiresAt: expiredAt,
    });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]?.expiresAt, expiredAt.toISOString());
  });

  it("returns an exact completed export replay after expiry but rejects a new expired export", async () => {
    let now = new Date("2026-07-14T10:00:00.000Z");
    const fake = new FakeCellProvisioner({ now: () => now });
    const provisioned = await fake.provision(provisionRequest());
    const target = {
      ...provisionRequest(),
      providerRef: provisioned.providerRef,
      context: {
        ...provisionRequest().context,
        checkpoint: "export-requested",
        idempotencyKey: "018f2d91-7c42-7000-8000-000000000041:export-requested",
      },
    };
    const expiresAt = new Date("2026-07-14T10:01:00.000Z");

    fake.loseNextAcknowledgement("export");
    await assert.rejects(
      fake.export({ ...target, expiresAt }),
      (error) => error instanceof ProvisionerFailure && error.code === "PROVISIONER_TIMEOUT"
    );

    now = new Date("2026-07-14T10:02:00.000Z");
    const replayed = await fake.export({ ...target, expiresAt });
    assert.equal(replayed.exportRef, `export-${target.context.operationId}`);
    assert.equal(fake.exportArtifacts.size, 1);

    await assert.rejects(
      fake.export({
        ...target,
        context: {
          ...target.context,
          operationId: "018f2d91-7c42-7000-8000-000000000051",
          idempotencyKey: "018f2d91-7c42-7000-8000-000000000051:export-requested",
        },
        expiresAt,
      }),
      (error) => error instanceof ProvisionerFailure && error.code === "PROVISIONER_REJECTED"
    );
    assert.equal(fake.exportArtifacts.size, 1);
  });

  it("reduces provider response bodies to stable retryable failures", async () => {
    const sentinel = "provider-content-secret-path-query-sentinel";
    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("provider-secret"),
        timeoutMs: 500,
      },
      async () => new Response(sentinel, { status: 503 })
    );

    await assert.rejects(
      adapter.health({ ...provisionRequest(), providerRef: "ref-1" }),
      (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.equal(error.code, "PROVISIONER_UNAVAILABLE");
        assert.equal(error.retryable, true);
        assert.equal(String(error).includes(sentinel), false);
        assert.equal(JSON.stringify(error).includes(sentinel), false);
        return true;
      }
    );
  });

  it("accepts only an exact echoed 202 pending response", async () => {
    const request = provisionRequest();
    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("provider-secret"),
        timeoutMs: 500,
      },
      async () =>
        Response.json(
          {
            status: "pending",
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 2,
          },
          { status: 202, headers: { "retry-after": "2" } }
        )
    );

    await assert.rejects(adapter.provision(request), (error) => {
      assert.ok(error instanceof ProvisionerPending);
      assert.equal(error.operationId, request.context.operationId);
      assert.equal(error.checkpoint, request.context.checkpoint);
      assert.equal(error.retryAfterSeconds, 2);
      return true;
    });
  });

  it("accepts the exact pending contract on every provisioner endpoint", async () => {
    const request = provisionRequest();
    const paths: string[] = [];
    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("provider-secret"),
        timeoutMs: 500,
      },
      async (input) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json(
          {
            status: "pending",
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 2,
          },
          { status: 202, headers: { "retry-after": "2" } }
        );
      }
    );
    const target = { ...request, providerRef: "provider-ref-1" };
    const exportRequest = { ...target, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    const calls: Array<() => Promise<unknown>> = [
      () => adapter.provision(request),
      () => adapter.health(target),
      () =>
        adapter.rotateCredential({
          ...target,
          phase: "stage",
          credentialVersion: 2,
          nextCredential: new SensitiveSecret("next-credential-1"),
        }),
      () => adapter.quiesce(target),
      () => adapter.resume(target),
      () => adapter.stop(target),
      () => adapter.export(exportRequest),
      () =>
        adapter.releaseExport({
          ...target,
          releaseRef: new SensitiveSecret("release-ref-1"),
        }),
      () =>
        adapter.deleteExport({
          context: request.context,
          tenantId: request.tenantId,
          exportRef: new SensitiveSecret("export-ref-1"),
        }),
      () =>
        adapter.createExportDownload({
          context: request.context,
          tenantId: request.tenantId,
          exportRef: new SensitiveSecret("export-ref-1"),
        }),
      () =>
        adapter.restore({
          ...target,
          restoreRef: new SensitiveSecret("restore-ref-1"),
          sourceCellId: "018f2d91-7c42-7000-8000-000000000044",
          archiveSha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
          archiveSize: 1024,
        }),
      () => adapter.seal(target),
      () => adapter.discard(target),
      () => adapter.destroy({ context: request.context, tenantId: request.tenantId }),
    ];

    for (const call of calls) {
      await assert.rejects(call(), (error) => {
        assert.ok(error instanceof ProvisionerPending);
        assert.equal(error.operationId, request.context.operationId);
        assert.equal(error.checkpoint, request.context.checkpoint);
        return true;
      });
    }

    assert.deepEqual(paths, [
      "/v1/cells/provision",
      "/v1/cells/health",
      "/v1/cells/rotate-credential",
      "/v1/cells/quiesce",
      "/v1/cells/resume",
      "/v1/cells/stop",
      "/v1/cells/export",
      "/v1/cells/export-release",
      "/v1/cells/export-delete",
      "/v1/cells/export-download",
      "/v1/cells/restore",
      "/v1/cells/seal",
      "/v1/cells/discard",
      "/v1/cells/destroy",
    ]);
  });

  it("rejects malformed, mismatched, or padded pending responses", async () => {
    const request = provisionRequest();
    const cases: Array<{ body: Record<string, unknown>; retryAfter: string }> = [
      {
        body: {
          status: "pending",
          operationId: "different-operation",
          checkpoint: request.context.checkpoint,
          retryAfterSeconds: 2,
        },
        retryAfter: "2",
      },
      {
        body: {
          status: "pending",
          operationId: request.context.operationId,
          checkpoint: request.context.checkpoint,
          retryAfterSeconds: 2,
          providerDetail: "must-not-be-accepted",
        },
        retryAfter: "2",
      },
      {
        body: {
          status: "pending",
          operationId: request.context.operationId,
          checkpoint: request.context.checkpoint,
          retryAfterSeconds: 2,
        },
        retryAfter: "3",
      },
    ];

    for (const testCase of cases) {
      const adapter = new HttpCellProvisioner(
        {
          endpoint: new URL("https://provisioner.internal.example/v1"),
          credential: new SensitiveSecret("provider-secret"),
          timeoutMs: 500,
        },
        async () =>
          Response.json(testCase.body, {
            status: 202,
            headers: { "retry-after": testCase.retryAfter },
          })
      );
      await assert.rejects(
        adapter.provision(request),
        (error) =>
          error instanceof ProvisionerFailure && error.code === "PROVISIONER_RESPONSE_INVALID"
      );
    }
  });

  it("authenticates explicit cell release and provider export deletion proofs", async () => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("provisioner-secret-sentinel"),
        timeoutMs: 500,
      },
      async (input, init) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return Response.json({ objectDestroyed: true });
      }
    );
    const target = { ...provisionRequest(), providerRef: "provider-ref-1" };

    await adapter.releaseExport({
      ...target,
      releaseRef: new SensitiveSecret("release-ref-1"),
    });
    await adapter.deleteExport({
      context: { ...target.context, idempotencyKey: "export-id-1:provider-delete" },
      tenantId: target.tenantId,
      exportRef: new SensitiveSecret("export-ref-1"),
    });

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "https://provisioner.internal.example/v1/cells/export-release",
        "https://provisioner.internal.example/v1/cells/export-delete",
      ]
    );
    assert.equal(calls[0]?.headers.get("idempotency-key"), target.context.idempotencyKey);
    assert.equal(calls[0]?.body.includes("release-ref-1"), true);
    assert.equal(calls[1]?.headers.get("idempotency-key"), "export-id-1:provider-delete");
    assert.equal(calls[1]?.body.includes("export-ref-1"), true);
  });

  it("requires authenticated HTTP proof that the prior credential is rejected", async () => {
    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("provisioner-secret-sentinel"),
        timeoutMs: 500,
      },
      async () => Response.json({ previousCredentialRejected: false })
    );

    await assert.rejects(
      adapter.rotateCredential({
        ...provisionRequest(),
        providerRef: "provider-ref-1",
        phase: "finalize",
        credentialVersion: 2,
        nextCredential: new SensitiveSecret("next-credential-sentinel"),
      }),
      (error) =>
        error instanceof ProvisionerFailure &&
        error.code === "PROVISIONER_RESPONSE_INVALID" &&
        error.retryable === false
    );
  });

  it("fails closed on missing or unsafe HTTP configuration", () => {
    delete process.env.EXOMEM_PROVISIONER_ENDPOINT;
    delete process.env.EXOMEM_PROVISIONER_CREDENTIAL;
    assert.throws(
      () => provisionerConfigFromEnv(),
      (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.equal(error.code, "PROVISIONER_CONFIGURATION_INVALID");
        assert.equal(error.retryable, false);
        return true;
      }
    );
  });
});
