import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

const ADMIN_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");
let importedRelease: string | null = null;
let createdAssignment: Record<string, unknown> | null = null;
let promotionInput: Record<string, unknown> | null = null;
let recoveryInput: Record<string, unknown> | null = null;
const queuedOperations: Array<Record<string, unknown>> = [];

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
  mock.module("@/lib/exomem-hosted/agent-contract-store", {
    namedExports: {
      attachOpenAiContractLocks: async () => true,
      demoteExomemAgentContractCandidate: async () => true,
      getLiveExomemHostedCohortCandidateId: async () => null,
      listExomemAgentContractStatus: async () => [],
      listExomemHostedRolloutStatus: async () => [
        {
          candidateId: "018f2d91-7c42-7000-8000-000000000021",
          state: "pending",
          sourceRelease: "0.35.0",
          routableCellCount: 1,
          routableSetDigest: "a".repeat(64),
          routableObservationFresh: true,
          observedSourceRelease: "0.35.0",
          observedProtocolVersion: "1",
          currentTargetSourceRelease: "0.35.0",
        },
      ],
      promoteExomemHostedCohort: async (input: Record<string, unknown>) => {
        promotionInput = input;
        return "promoted";
      },
      storeExomemAgentContractCandidate: async () => "candidate-current",
      storeRetainedExomemAgentContractCandidate: async (sourceRelease: string) => {
        importedRelease = sourceRelease;
        return "candidate-fresh";
      },
    },
  });
  mock.module("@/lib/exomem-hosted/client-artifacts", {
    namedExports: { storeClientArtifact: async () => "artifact-1" },
  });
  mock.module("@/lib/exomem-hosted/agent-contract-canaries", {
    namedExports: {
      createCanaryAssignment: async (input: Record<string, unknown>) => {
        createdAssignment = input;
        return {
          id: "assignment-1",
          generation: 1,
          version: 1,
          state: "preparing",
          expiresAt: "x",
        };
      },
      createStagedClientRelease: async () => ({ id: "stage-1", version: 1, state: "staged" }),
      expireCanaryAuthority: async () => ({
        expiredAssignments: 0,
        expiredStages: 0,
        revokedCredentials: 0,
        drained: true,
      }),
      failCanaryAssignment: async () => true,
      failStagedClientRelease: async () => true,
    },
  });
  mock.module("@/lib/exomem-hosted/lifecycle-store", {
    namedExports: {
      getExomemHostedContractionReadiness: async () => ({
        ready: false,
        unfinishedV1Operations: 2,
        retainedV1Exports: 1,
      }),
      SqlLifecycleStore: class {
        async getAvailableRestoreBinding() {
          return {
            exportId: "018f2d91-7c42-7000-8000-000000000015",
            sourceCellId: "018f2d91-7c42-7000-8000-000000000016",
            archiveSha256: "a".repeat(64),
            manifestSha256: "b".repeat(64),
            archiveSize: 1,
          };
        }
        async enqueue(
          tenantId: string,
          operationType: string,
          idempotencyKey: string,
          cellId?: string | null,
          options?: Record<string, unknown>
        ) {
          queuedOperations.push({ tenantId, operationType, idempotencyKey, cellId, options });
          return { id: "operation-1", state: "pending", target: { sourceRelease: "0.35.0" } };
        }
      },
    },
  });
  mock.module("@/lib/exomem-hosted/operator-controls", {
    namedExports: {
      demoteOperatorClientArtifact: async () => true,
      listOperatorClientArtifacts: async () => [],
      preflightRecoverExpiredReviewerCleanup: async (input: Record<string, unknown>) => {
        recoveryInput = input;
        return { eligible: true };
      },
      preflightRecoverTerminalReviewerDelete: async (input: Record<string, unknown>) => {
        recoveryInput = input;
        return { eligible: true };
      },
      recoverExpiredReviewerCleanup: async (input: Record<string, unknown>) => {
        recoveryInput = input;
        return { outcome: "replayed", operationId: "018f2d91-7c42-7000-8000-000000000099" };
      },
      recoverTerminalReviewerDelete: async (input: Record<string, unknown>) => {
        recoveryInput = input;
        return { outcome: "replayed", operationId: "018f2d91-7c42-7000-8000-000000000099" };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: {
        adminPreAuthReadIp: { scope: "read-ip", limit: 1, windowSeconds: 60 },
        adminPreAuthMutationIp: { scope: "mutation-ip", limit: 1, windowSeconds: 60 },
        adminAuthenticatedRead: { scope: "read", limit: 1, windowSeconds: 60 },
        adminAuthenticatedMutation: { scope: "mutation", limit: 1, windowSeconds: 60 },
      },
      clientAddressKey: () => "test-ip",
      takeExomemRateLimit: async () => true,
    },
  });
});

after(() => {
  delete process.env.EXOMEM_ADMIN_TOKEN;
  mock.reset();
});

function request(body: unknown, authorization?: string) {
  return new Request("https://substratesystems.io/api/exomem/admin/contracts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem operator contract controls", () => {
  it("keeps reviewer-cleanup preflight and recovery bounded and content-free", async () => {
    const { POST } = await import("../route");
    const sourceOperationId = "018f2d91-7c42-7000-8000-000000000091";
    const expectedFence = 7;
    const preflight = await POST(
      request(
        { action: "preflight-recover-expired-reviewer-cleanup", sourceOperationId, expectedFence },
        `Bearer ${ADMIN_TOKEN}`
      )
    );
    assert.equal(preflight.status, 200);
    const preflightBody = await preflight.json();
    assert.deepEqual(Object.keys(preflightBody).sort(), ["eligible", "requestId", "success"]);
    assert.equal(preflightBody.eligible, true);
    assert.equal(typeof preflightBody.requestId, "string");
    assert.equal(recoveryInput?.sourceOperationId, sourceOperationId);
    assert.equal(recoveryInput?.expectedFence, expectedFence);

    const recovered = await POST(
      request(
        { action: "recover-expired-reviewer-cleanup", sourceOperationId, expectedFence },
        `Bearer ${ADMIN_TOKEN}`
      )
    );
    assert.equal(recovered.status, 200);
    const body = await recovered.json();
    assert.deepEqual(Object.keys(body).sort(), ["operationId", "outcome", "requestId", "success"]);
    assert.equal(body.outcome, "replayed");
    assert.equal(body.operationId, "018f2d91-7c42-7000-8000-000000000099");
    assert.equal(typeof body.requestId, "string");
    assert.equal(JSON.stringify(body).includes(sourceOperationId), false);
  });

  it("rejects unauthenticated or malformed reviewer-cleanup recovery requests", async () => {
    const { POST } = await import("../route");
    assert.equal(
      (
        await POST(
          request({
            action: "recover-expired-reviewer-cleanup",
            sourceOperationId: "no",
            expectedFence: 0,
          })
        )
      ).status,
      401
    );
    assert.equal(
      (
        await POST(
          request(
            {
              action: "recover-expired-reviewer-cleanup",
              sourceOperationId: "no",
              expectedFence: 0,
            },
            `Bearer ${ADMIN_TOKEN}`
          )
        )
      ).status,
      400
    );
  });

  it("keeps terminal-reviewer-delete preflight and replay content-free", async () => {
    const { POST } = await import("../route");
    const operationId = "018f2d91-7c42-7000-8000-000000000091";
    const preflight = await POST(
      request(
        { action: "preflight-recover-terminal-reviewer-delete", operationId, expectedFence: 7 },
        `Bearer ${ADMIN_TOKEN}`
      )
    );
    assert.equal(preflight.status, 200);
    assert.deepEqual(Object.keys(await preflight.json()).sort(), ["eligible", "requestId", "success"]);
    assert.deepEqual(recoveryInput, { operationId, expectedFence: 7 });

    const replay = await POST(
      request(
        { action: "recover-terminal-reviewer-delete", operationId, expectedFence: 7 },
        `Bearer ${ADMIN_TOKEN}`
      )
    );
    assert.equal(replay.status, 200);
    const body = await replay.json();
    assert.deepEqual(Object.keys(body).sort(), ["operationId", "outcome", "requestId", "success"]);
    assert.equal(body.outcome, "replayed");
    assert.equal(JSON.stringify(body).includes(operationId), false);
  });

  it("rejects malformed or refused terminal-reviewer-delete replay requests", async () => {
    const { POST } = await import("../route");
    assert.equal(
      (
        await POST(
          request(
            { action: "recover-terminal-reviewer-delete", operationId: "no", expectedFence: 0 },
            `Bearer ${ADMIN_TOKEN}`
          )
        )
      ).status,
      400
    );
    assert.equal(
      (
        await POST(
          request(
            {
              action: "recover-terminal-reviewer-delete",
              operationId: "018f2d91-7c42-7000-8000-000000000091",
              expectedFence: 7,
              sourceOperationId: "018f2d91-7c42-7000-8000-000000000092",
            },
            `Bearer ${ADMIN_TOKEN}`
          )
        )
      ).status,
      400
    );
  });

  it("returns only content-free rollout and contraction readiness", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request("https://substratesystems.io/api/exomem/admin/contracts", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.rolloutStatus, [
      {
        candidateId: "018f2d91-7c42-7000-8000-000000000021",
        state: "pending",
        sourceRelease: "0.35.0",
        routableCellCount: 1,
        routableSetDigest: "a".repeat(64),
        routableObservationFresh: true,
        observedSourceRelease: "0.35.0",
        observedProtocolVersion: "1",
        currentTargetSourceRelease: "0.35.0",
      },
    ]);
    assert.deepEqual(body.contractionReadiness, {
      ready: false,
      unfinishedV1Operations: 2,
      retainedV1Exports: 1,
    });
  });

  it("creates a canary assignment with the authenticated operator digest", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request(
        {
          action: "create-assignment",
          tenantId: "018f2d91-7c42-7000-8000-000000000011",
          candidateId: "018f2d91-7c42-7000-8000-000000000012",
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
        `Bearer ${ADMIN_TOKEN}`
      )
    );
    assert.equal(response.status, 200);
    assert.equal(createdAssignment?.tenantId, "018f2d91-7c42-7000-8000-000000000011");
    assert.equal(typeof createdAssignment?.operatorPrincipalDigest, "string");
  });

  it("forwards the status CAS unchanged to cohort promotion", async () => {
    const { GET, POST } = await import("../route");
    const status = await GET(
      new Request("https://substratesystems.io/api/exomem/admin/contracts", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }) as unknown as import("next/server").NextRequest
    );
    const digest = (await status.json()).rolloutStatus[0].routableSetDigest;
    const response = await POST(
      request(
        {
          action: "promote-cohort",
          candidateId: "018f2d91-7c42-7000-8000-000000000021",
          claudeArtifactId: "018f2d91-7c42-7000-8000-000000000022",
          openaiArtifactId: "018f2d91-7c42-7000-8000-000000000023",
          expectedLiveCandidateId: null,
          expectedRoutableCellDigest: digest,
          claudeEvidence: {},
          openaiEvidence: {},
        },
        `Bearer ${ADMIN_TOKEN}`
      )
    );
    assert.equal(response.status, 200);
    assert.equal(promotionInput?.expectedRoutableCellDigest, digest);
  });

  it("reports expired authority counts and whether another expiry batch remains", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({ action: "expire-canary-authority" }, `Bearer ${ADMIN_TOKEN}`)
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).expired, {
      expiredAssignments: 0,
      expiredStages: 0,
      revokedCredentials: 0,
      drained: true,
    });
  });

  it("initiates content-free export and restore operations through the pinned lifecycle target", async () => {
    const { POST } = await import("../route");
    for (const body of [
      {
        action: "begin-export",
        tenantId: "018f2d91-7c42-7000-8000-000000000011",
        idempotencyKey: "operator-export-1",
      },
      {
        action: "begin-restore",
        tenantId: "018f2d91-7c42-7000-8000-000000000011",
        exportId: "018f2d91-7c42-7000-8000-000000000015",
        idempotencyKey: "operator-restore-1",
      },
    ]) {
      const response = await POST(request(body, `Bearer ${ADMIN_TOKEN}`));
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).operation, {
        id: "operation-1",
        state: "pending",
        target: { sourceRelease: "0.35.0" },
      });
    }
    assert.deepEqual(
      queuedOperations.map((operation) => operation.operationType),
      ["export", "restore"]
    );
    const restoreOptions = queuedOperations[1]?.options as Record<string, unknown> | undefined;
    assert.equal(
      (restoreOptions?.restoreBinding as Record<string, unknown> | undefined)?.exportId,
      "018f2d91-7c42-7000-8000-000000000015"
    );
  });

  it("requires operator authority to re-import a retained release as a fresh candidate", async () => {
    const { POST } = await import("../route");
    assert.equal(
      (await POST(request({ action: "import-retained-agent", sourceRelease: "0.49.0" }))).status,
      401
    );
    const response = await POST(
      request({ action: "import-retained-agent", sourceRelease: "0.49.0" }, `Bearer ${ADMIN_TOKEN}`)
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).candidateId, "candidate-fresh");
    assert.equal(importedRelease, "0.49.0");
  });

  it("rejects releases outside the immutable retained catalog", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({ action: "import-retained-agent", sourceRelease: "0.24.0" }, `Bearer ${ADMIN_TOKEN}`)
    );
    assert.equal(response.status, 400);
    assert.equal(importedRelease, "0.49.0");
  });
});
