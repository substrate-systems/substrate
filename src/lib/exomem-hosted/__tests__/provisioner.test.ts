import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  FakeCellProvisioner,
  HttpCellProvisioner,
  ProvisionerFailure,
  provisionerConfigFromEnv,
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
    assert.equal(
      headers.get("idempotency-key"),
      "018f2d91-7c42-7000-8000-000000000041:candidate-created"
    );
    const body = String(captured?.init.body);
    assert.equal(body.includes("credential-sensitive-sentinel"), true);
    assert.equal(body.includes("email"), false);
    assert.equal(body.toLowerCase().includes("paddle"), false);
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
