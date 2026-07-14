import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  HttpCellProvisioner,
  ProvisionerFailure,
  ProvisionerPending,
  type ProvisionCellRequest,
} from "../provisioner";
import { SensitiveSecret } from "../security";
import rawFixture from "./provisioner-v1-cross-language.json";

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

const fixture = rawFixture as ContractFixture;
const FIXTURE_SHA256 = "c479933e0fb83197bd548e2333ac66fe8db5406a0a230f76ad867a1a4df920f5";

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
  target: ProvisionCellRequest & { providerRef: string };
  body: JsonRecord;
} {
  const body = materialize(testCase.request);
  const provision: ProvisionCellRequest = {
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
  return {
    provision,
    target: { ...provision, providerRef: String(body.providerRef) },
    body,
  };
}

async function invoke(
  action: string,
  testCase: ActionCase,
  providerResponse: Response
): Promise<{ result: unknown; sent: JsonRecord }> {
  let sent: JsonRecord | null = null;
  const adapter = new HttpCellProvisioner(
    {
      endpoint: new URL("https://provisioner.internal.example/v1"),
      credential: new SensitiveSecret("fixture-provisioner-bearer-000000000"),
      timeoutMs: 500,
    },
    async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as JsonRecord;
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
      result = await adapter.export(target);
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
  return { result, sent };
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
      const { result, sent } = await invoke(action, testCase, response(final.status, final.body));
      assert.deepEqual(sent, materialize(testCase.request), action);
      assert.deepEqual(normalizedResult(action, result), final.body, action);
    }
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
