import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  HttpCellProvisioner,
  ProvisionerFailure,
  ProvisionerPending,
  type CellTargetRequest,
  type ProvisionCellRequest,
} from "../provisioner";
import { SensitiveSecret } from "../security";
import rawFixture from "./provisioner-v1-cross-language.json";
import rawV2Fixture from "./provisioner-v2-cross-language.json";

type JsonRecord = Record<string, unknown>;
type ActionCase = {
  idempotencyKey: string;
  request: JsonRecord;
  pending: { status: number; headers: Record<string, string>; body: JsonRecord };
  final: { status: number; body: JsonRecord | null };
};
type ContractFixture = {
  schemaVersion: number;
  protocol: string;
  actions: Record<string, ActionCase>;
  errors: Array<{
    status: number;
    body: { code: string; retryable: boolean };
    expectedTypeScript: { code: string; retryable: boolean };
  }>;
};
type V2ContractFixture = Omit<ContractFixture, "errors"> & {
  failures: Array<{
    status: number;
    body: { code: string; retryable: boolean };
  }>;
  mismatch: { status: number; body: { code: string; retryable: boolean } };
  replayFailure: { status: number; body: { code: string; retryable: boolean } };
};

const fixture = rawFixture as ContractFixture;
const v2Fixture = rawV2Fixture as unknown as V2ContractFixture;
const FIXTURE_SHA256 = "ced714a5aa204a837e22cab831262cc0ae4766e44720b2896e61b8c157ddd3b5";
const V2_FIXTURE_SHA256 = "b57a9c51e4b4f818ea52aee70e14ffcf13f91d6dc701ca579fcb73a174e843ff";

function credential(seed: string): string {
  return createHash("sha256").update(seed).digest("base64url");
}

function materialize<T>(value: T): T {
  if (value === "$ACTIVE_SERVICE_CREDENTIAL") {
    return credential("cross-language-active") as T;
  }
  if (value === "$NEXT_SERVICE_CREDENTIAL") {
    return credential("cross-language-next") as T;
  }
  if (value === "$NOW_PLUS_600_SECONDS") {
    return new Date(Date.now() + 10 * 60 * 1000).toISOString() as T;
  }
  if (value === "$NOW_PLUS_86400_SECONDS") {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() as T;
  }
  if (Array.isArray(value)) return value.map((item) => materialize(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, materialize(item)])
    ) as T;
  }
  return value;
}

function response(status: number, body: JsonRecord | null, headers = {}): Response {
  return body === null
    ? new Response(null, { status, headers })
    : Response.json(body, { status, headers });
}

function clientRequest(testCase: ActionCase): {
  provision: ProvisionCellRequest;
  target: CellTargetRequest;
  body: JsonRecord;
} {
  const body = materialize(testCase.request);
  const cell = {
    context: {
      operationId: String(body.operationId),
      checkpoint: String(body.checkpoint),
      idempotencyKey: testCase.idempotencyKey,
      fenceGeneration: Number(body.fenceGeneration),
    },
    tenantId: String(body.tenantId),
    cellId: String(body.cellId),
    protocolVersion: String(body.protocolVersion),
    releaseVersion: String(body.releaseVersion),
    serviceCredential: new SensitiveSecret(String(body.serviceCredential)),
    workerPolicy: body.workerPolicy as ProvisionCellRequest["workerPolicy"],
  };
  const provision: ProvisionCellRequest = {
    ...cell,
    provisionMode: body.provisionMode === "restore-candidate" ? "restore-candidate" : "serve",
  };
  return {
    provision,
    target: { ...cell, providerRef: String(body.providerRef) },
    body,
  };
}

function v2ProvisionRequest(): ProvisionCellRequest {
  const body = materialize(v2Fixture.actions.provision.request);
  const runtimeTarget = body.runtimeTarget as JsonRecord;
  return {
    context: {
      operationId: String(body.operationId),
      checkpoint: String(body.checkpoint),
      idempotencyKey: v2Fixture.actions.provision.idempotencyKey,
      fenceGeneration: Number(body.fenceGeneration),
    },
    tenantId: String(body.tenantId),
    cellId: String(body.cellId),
    protocolVersion: String(runtimeTarget.protocolVersion),
    releaseVersion: String(runtimeTarget.releaseVersion),
    agentProfile: String(runtimeTarget.agentProfile),
    runtimeTarget: {
      releaseVersion: String(runtimeTarget.releaseVersion),
      protocolVersion: String(runtimeTarget.protocolVersion),
      agentProfile: String(runtimeTarget.agentProfile),
      gatewayContractDigest: String(runtimeTarget.gatewayContractDigest),
      commandFingerprint: String(runtimeTarget.commandFingerprint),
      schemaDigest: String(runtimeTarget.schemaDigest),
    },
    contractIdentity: {
      gatewayContractDigest: String(runtimeTarget.gatewayContractDigest),
      commandFingerprint: String(runtimeTarget.commandFingerprint),
      schemaDigest: String(runtimeTarget.schemaDigest),
      compatibilityDigest: "d".repeat(64),
    },
    serviceCredential: new SensitiveSecret(String(body.serviceCredential)),
    workerPolicy: body.workerPolicy as ProvisionCellRequest["workerPolicy"],
    provisionerWireProtocol: "exomem-cell-provisioner.v2",
    provisionMode: "serve",
  };
}

async function invoke(
  action: string,
  testCase: ActionCase,
  providerResponse: Response
): Promise<{ result: unknown; sent: JsonRecord; header: string | null; expectedRequest: JsonRecord }> {
  let sent: JsonRecord | null = null;
  let header: string | null = null;
  const adapter = new HttpCellProvisioner(
    {
      endpoint: new URL("https://provisioner.internal.example/v1"),
      credential: new SensitiveSecret("fixture-provisioner-bearer-000000000"),
      timeoutMs: 500,
    },
    async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as JsonRecord;
      header = new Headers(init?.headers).get("x-exomem-provisioner-protocol");
      return providerResponse;
    }
  );
  const { provision, target, body } = clientRequest(testCase);
  let result: unknown;
  switch (action) {
    case "provision":
      result = await adapter.provision(provision);
      break;
    case "health":
      result = await adapter.health(target);
      break;
    case "rotate-credential":
      result = await adapter.rotateCredential({
        ...target,
        phase: body.phase as "stage" | "finalize",
        credentialVersion: Number(body.credentialVersion),
        nextCredential: new SensitiveSecret(String(body.nextCredential)),
      });
      break;
    case "quiesce":
      result = await adapter.quiesce(target);
      break;
    case "resume":
      result = await adapter.resume(target);
      break;
    case "stop":
      result = await adapter.stop(target);
      break;
    case "export":
      result = await adapter.export({
        ...target,
        expiresAt: new Date(String(body.expiresAt)),
      });
      break;
    case "export-release":
      result = await adapter.releaseExport({
        ...target,
        releaseRef: new SensitiveSecret(String(body.releaseRef)),
      });
      break;
    case "export-delete":
      result = await adapter.deleteExport({
        context: provision.context,
        tenantId: provision.tenantId,
        exportRef: new SensitiveSecret(String(body.exportRef)),
      });
      break;
    case "restore":
      result = await adapter.restore({
        ...target,
        restoreRef: new SensitiveSecret(String(body.restoreRef)),
        sourceCellId: String(body.sourceCellId),
        archiveSha256: String(body.archiveSha256),
        manifestSha256: String(body.manifestSha256),
        archiveSize: Number(body.archiveSize),
      });
      break;
    case "export-download":
      result = await adapter.createExportDownload({
        context: provision.context,
        tenantId: provision.tenantId,
        exportRef: new SensitiveSecret(String(body.exportRef)),
      });
      break;
    case "seal":
      result = await adapter.seal(target);
      break;
    case "discard":
      result = await adapter.discard(target);
      break;
    case "destroy":
      result = await adapter.destroy({ context: provision.context, tenantId: provision.tenantId });
      break;
    default:
      throw new Error(`unknown fixture action: ${action}`);
  }
  assert.ok(sent);
  return { result, sent, header, expectedRequest: body };
}

function normalizedResult(action: string, result: unknown): unknown {
  if (["quiesce", "resume", "stop", "export-release", "restore", "seal"].includes(action)) {
    return null;
  }
  if (action === "provision") {
    const value = result as { providerRef: string; privateEndpoint: SensitiveSecret };
    return { providerRef: value.providerRef, privateEndpoint: value.privateEndpoint.reveal() };
  }
  if (action === "export-download") {
    const value = result as { url: URL; expiresAt: Date };
    return { url: value.url.toString(), expiresAt: value.expiresAt.toISOString() };
  }
  if (action === "health" && (result as { runtimeIdentity?: unknown }).runtimeIdentity) {
    const wireResult = { ...(result as Record<string, unknown>) };
    delete wireResult.protocolVersion;
    delete wireResult.releaseVersion;
    return wireResult;
  }
  return result;
}

describe("Python provisioner v1 interoperability corpus", () => {
  it("serializes every request and parses every exact pending response", async () => {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL("./provisioner-v1-cross-language.json", import.meta.url)))
        .digest("hex"),
      FIXTURE_SHA256
    );
    assert.equal(fixture.schemaVersion, 1);
    assert.equal(fixture.protocol, "exomem-cell-provisioner.v1");
    assert.equal(fixture.actions.health?.final.body?.code, "CELL_READY");
    for (const [action, testCase] of Object.entries(fixture.actions)) {
      const pending = testCase.pending;
      await assert.rejects(
        invoke(action, testCase, response(pending.status, pending.body, pending.headers)),
        (error) => {
          assert.ok(error instanceof ProvisionerPending);
          assert.equal(error.operationId, testCase.request.operationId);
          assert.equal(error.checkpoint, testCase.request.checkpoint);
          assert.equal(error.retryAfterSeconds, 2);
          return true;
        }
      );
    }
  });

  it("serializes every request and parses every exact final proof", async () => {
    for (const [action, testCase] of Object.entries(fixture.actions)) {
      const final = materialize(testCase.final);
      const { result, sent, header, expectedRequest } = await invoke(
        action,
        testCase,
        response(final.status, final.body)
      );
      assert.deepEqual(sent, expectedRequest, action);
      assert.equal(header, fixture.protocol, action);
      assert.deepEqual(normalizedResult(action, result), final.body, action);
    }
  });

  it("rejects a noncanonical success code before it reaches a lifecycle store", async () => {
    const health = fixture.actions.health;
    assert.ok(health?.final.body);
    await assert.rejects(
      invoke(
        "health",
        health,
        response(health.final.status, {
          ...materialize(health.final.body),
          code: "READY",
        })
      ),
      (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.deepEqual(error.toJSON(), {
          code: "PROVISIONER_RESPONSE_INVALID",
          retryable: false,
        });
        return true;
      }
    );
  });

  it("preserves every exact content-free Python error class", async () => {
    const provision = fixture.actions.provision;
    assert.ok(provision);
    for (const testCase of fixture.errors) {
      await assert.rejects(
        invoke("provision", provision, response(testCase.status, testCase.body)),
        (error) => {
          assert.ok(error instanceof ProvisionerFailure);
          assert.deepEqual(error.toJSON(), testCase.expectedTypeScript);
          return true;
        }
      );
    }
  });

  it("bounds malformed, oversized, and failed response streams without leaking content", async () => {
    const provision = fixture.actions.provision;
    assert.ok(provision);

    const forged = "provider-controlled-error-detail-sentinel";
    let malformedCancelled = false;
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              code: "CONTROL_PLANE_STATE_CONFLICT",
              retryable: false,
              detail: forged,
            })
          )
        );
      },
      cancel() {
        malformedCancelled = true;
      },
    });
    await assert.rejects(
      invoke(
        "provision",
        provision,
        new Response(malformed, { status: 409, headers: { "content-length": "invalid" } })
      ),
      (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.deepEqual(error.toJSON(), { code: "PROVISIONER_REJECTED", retryable: false });
        assert.equal(String(error).includes(forged), false);
        return true;
      }
    );
    assert.equal(malformedCancelled, true);

    let pulls = 0;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(300_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      invoke("provision", provision, new Response(oversized, { status: 503 })),
      (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.deepEqual(error.toJSON(), { code: "PROVISIONER_UNAVAILABLE", retryable: true });
        return true;
      }
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 5, `oversized stream pulled ${pulls} chunks`);

    const failed = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(forged));
      },
    });
    await assert.rejects(
      invoke("provision", provision, new Response(failed, { status: 200 })),
      (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.deepEqual(error.toJSON(), { code: "PROVISIONER_UNAVAILABLE", retryable: true });
        assert.equal(String(error).includes(forged), false);
        assert.equal(JSON.stringify(error).includes(forged), false);
        return true;
      }
    );
  });
});

describe("Python provisioner v2 interoperability corpus", () => {
  it("serializes every exact v2 body with its matching header and parses exact final responses", async () => {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL("./provisioner-v2-cross-language.json", import.meta.url)))
        .digest("hex"),
      V2_FIXTURE_SHA256
    );
    assert.equal(v2Fixture.schemaVersion, 2);
    assert.equal(v2Fixture.protocol, "exomem-cell-provisioner.v2");

    for (const [action, testCase] of Object.entries(v2Fixture.actions)) {
      const body = materialize(testCase.request);
      const runtimeTarget = body.runtimeTarget as JsonRecord | undefined;
      const base = {
        context: {
          operationId: String(body.operationId),
          checkpoint: String(body.checkpoint),
          idempotencyKey: testCase.idempotencyKey,
          fenceGeneration: Number(body.fenceGeneration),
        },
        tenantId: String(body.tenantId),
        cellId: String(body.cellId),
        protocolVersion: String(runtimeTarget?.protocolVersion),
        releaseVersion: String(runtimeTarget?.releaseVersion),
        agentProfile: String(runtimeTarget?.agentProfile),
        runtimeTarget: runtimeTarget as {
          releaseVersion: string;
          protocolVersion: string;
          agentProfile: string;
          gatewayContractDigest: string;
          commandFingerprint: string;
          schemaDigest: string;
        },
        contractIdentity: {
          gatewayContractDigest: String(runtimeTarget?.gatewayContractDigest),
          commandFingerprint: String(runtimeTarget?.commandFingerprint),
          schemaDigest: String(runtimeTarget?.schemaDigest),
          compatibilityDigest: "d".repeat(64),
        },
        serviceCredential: new SensitiveSecret(String(body.serviceCredential)),
        workerPolicy: body.workerPolicy as ProvisionCellRequest["workerPolicy"],
        provisionerWireProtocol: "exomem-cell-provisioner.v2",
      };
      let sent: JsonRecord | null = null;
      let header: string | null = null;
      let pending = true;
      const adapter = new HttpCellProvisioner(
        {
          endpoint: new URL("https://provisioner.internal.example/v1"),
          credential: new SensitiveSecret("fixture-provisioner-bearer-000000000"),
          timeoutMs: 500,
        },
        async (_input, init) => {
          sent = JSON.parse(String(init?.body)) as JsonRecord;
          header = new Headers(init?.headers).get("x-exomem-provisioner-protocol");
          return pending
            ? response(testCase.pending.status, testCase.pending.body, testCase.pending.headers)
            : response(testCase.final.status, materialize(testCase.final.body));
        }
      );
      const invokeV2 = async (): Promise<unknown> => {
        switch (action) {
        case "provision":
          return adapter.provision({ ...base, provisionMode: "serve" } as ProvisionCellRequest);
        case "health":
          return adapter.health({ ...base, providerRef: String(body.providerRef) } as CellTargetRequest);
        case "rotate-credential":
          return adapter.rotateCredential({
            ...base,
            providerRef: String(body.providerRef),
            phase: body.phase as "stage" | "finalize",
            credentialVersion: Number(body.credentialVersion),
            nextCredential: new SensitiveSecret(String(body.nextCredential)),
          } as never);
        case "quiesce":
        case "resume":
        case "stop":
        case "seal":
          return adapter[action]({ ...base, providerRef: String(body.providerRef) } as never);
        case "export":
          return adapter.export({
            ...base,
            providerRef: String(body.providerRef),
            expiresAt: new Date(String(body.expiresAt)),
          } as never);
        case "export-release":
          return adapter.releaseExport({
            ...base,
            providerRef: String(body.providerRef),
            releaseRef: new SensitiveSecret(String(body.releaseRef)),
          } as never);
        case "export-delete":
          return adapter.deleteExport({
            context: base.context,
            tenantId: base.tenantId,
            exportRef: new SensitiveSecret(String(body.exportRef)),
            provisionerWireProtocol: base.provisionerWireProtocol,
          } as never);
        case "restore":
          return adapter.restore({
            ...base,
            providerRef: String(body.providerRef),
            restoreRef: new SensitiveSecret(String(body.restoreRef)),
            sourceCellId: String(body.sourceCellId),
            archiveSha256: String(body.archiveSha256),
            manifestSha256: String(body.manifestSha256),
            archiveSize: Number(body.archiveSize),
          } as never);
        case "export-download":
          return adapter.createExportDownload({
            context: base.context,
            tenantId: base.tenantId,
            exportRef: new SensitiveSecret(String(body.exportRef)),
            provisionerWireProtocol: base.provisionerWireProtocol,
          } as never);
        case "discard":
          return adapter.discard({ ...base, providerRef: String(body.providerRef) } as never);
        case "destroy":
          return adapter.destroy({
            context: base.context,
            tenantId: base.tenantId,
            provisionerWireProtocol: base.provisionerWireProtocol,
          } as never);
        default:
          throw new Error(`unknown fixture action: ${action}`);
        }
      };
      await assert.rejects(invokeV2(), (error) => {
        assert.ok(error instanceof ProvisionerPending);
        assert.equal(error.operationId, body.operationId);
        assert.equal(error.checkpoint, body.checkpoint);
        return true;
      });
      pending = false;
      const result = await invokeV2();
      assert.equal(header, v2Fixture.protocol, action);
      assert.deepEqual(sent, body, action);
      assert.deepEqual(normalizedResult(action, result), materialize(testCase.final.body), action);
    }
  });

  it("rejects exact v2 failures and mixed v1 health envelopes", async () => {
    for (const failure of [
      ...v2Fixture.failures,
      v2Fixture.mismatch,
      v2Fixture.replayFailure,
    ]) {
      const adapter = new HttpCellProvisioner(
        {
          endpoint: new URL("https://provisioner.internal.example/v1"),
          credential: new SensitiveSecret("fixture-provisioner-bearer-000000000"),
          timeoutMs: 500,
        },
        async () => response(failure.status, failure.body)
      );
      await assert.rejects(adapter.provision(v2ProvisionRequest()), (error) => {
        assert.ok(error instanceof ProvisionerFailure);
        assert.deepEqual(error.toJSON(), failure.body);
        return true;
      });
    }

    const adapter = new HttpCellProvisioner(
      {
        endpoint: new URL("https://provisioner.internal.example/v1"),
        credential: new SensitiveSecret("fixture-provisioner-bearer-000000000"),
        timeoutMs: 500,
      },
      async () =>
        response(200, {
          live: true,
          ready: true,
          cellId: "cell-v2-alpha",
          protocolVersion: "1",
          releaseVersion: "0.35.1",
          serviceAuthenticated: true,
          mutationAuthority: true,
          readAdmission: true,
          writeAdmission: true,
          workerPolicy: { workerCount: 0, semantic: false, media: false },
          code: "CELL_READY",
        })
    );
    await assert.rejects(
      adapter.health({ ...v2ProvisionRequest(), providerRef: "hcloud.volume.fixture-alpha" }),
      (error) =>
        error instanceof ProvisionerFailure && error.code === "PROVISIONER_RESPONSE_INVALID"
    );
  });
});
