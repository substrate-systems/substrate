import { NextRequest, NextResponse } from "next/server";
import {
  attachOpenAiContractLocks,
  demoteExomemAgentContractCandidate,
  getLiveExomemHostedCohortCandidateId,
  listExomemAgentContractStatus,
  listExomemHostedRolloutStatus,
  promoteExomemHostedCohort,
  storeExomemAgentContractCandidate,
  storeRetainedExomemAgentContractCandidate,
} from "@/lib/exomem-hosted/agent-contract-store";
import { storeClientArtifact } from "@/lib/exomem-hosted/client-artifacts";
import {
  createCanaryAssignment,
  createStagedClientRelease,
  expireCanaryAuthority,
  failCanaryAssignment,
  failStagedClientRelease,
} from "@/lib/exomem-hosted/agent-contract-canaries";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { SqlLifecycleStore } from "@/lib/exomem-hosted/lifecycle-store";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  readOperatorJsonRecord,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";
import {
  demoteOperatorClientArtifact,
  listOperatorClientArtifacts,
} from "@/lib/exomem-hosted/operator-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const uuid = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;
const digest = (value: unknown): string | null =>
  typeof value === "string" && SHA256.test(value) ? value : null;
const idempotencyKey = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const [agentContracts, clientArtifacts, liveCohortCandidateId, rolloutStatus] =
      await Promise.all([
        listExomemAgentContractStatus(),
        listOperatorClientArtifacts(),
        getLiveExomemHostedCohortCandidateId(),
        listExomemHostedRolloutStatus(),
      ]);
    operatorSuccessEvent(requestId);
    return NextResponse.json({
      success: true,
      agentContracts,
      clientArtifacts,
      liveCohortCandidateId,
      rolloutStatus,
      requestId,
    });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const operator = await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    let response: Record<string, unknown>;
    if (body.action === "import-agent") {
      response = { candidateId: await storeExomemAgentContractCandidate() };
    } else if (body.action === "import-retained-agent") {
      if (
        body.sourceRelease !== "0.34.0" &&
        body.sourceRelease !== "0.35.0" &&
        body.sourceRelease !== "0.39.2"
      )
        throw exomemErrors.invalidRequest();
      response = {
        candidateId: await storeRetainedExomemAgentContractCandidate(body.sourceRelease),
      };
    } else if (body.action === "create-assignment") {
      const tenantId = uuid(body.tenantId);
      const candidateId = uuid(body.candidateId);
      const expiresAt = typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null;
      if (!tenantId || !candidateId || !expiresAt || Number.isNaN(expiresAt.valueOf()))
        throw exomemErrors.invalidRequest();
      response = {
        assignment: await createCanaryAssignment({
          tenantId,
          candidateId,
          expiresAt,
          operatorPrincipalDigest: operator.principalDigest.toString("hex"),
        }),
      };
    } else if (body.action === "create-stage") {
      const candidateId = uuid(body.candidateId);
      const expiresAt = typeof body.expiresAt === "string" ? new Date(body.expiresAt) : null;
      const packageSha256 = digest(body.packageSha256);
      const archiveSha256 = digest(body.archiveSha256);
      const compatibilitySha256 = digest(body.compatibilitySha256);
      const contractSha256 = digest(body.contractSha256);
      const oauthClientConfigSha256 = digest(body.oauthClientConfigSha256);
      const registeredAppIdSha256 =
        body.registeredAppIdSha256 === null ? null : digest(body.registeredAppIdSha256);
      if (
        !candidateId ||
        (body.platform !== "claude" && body.platform !== "openai") ||
        !expiresAt ||
        Number.isNaN(expiresAt.valueOf()) ||
        !packageSha256 ||
        !archiveSha256 ||
        !compatibilitySha256 ||
        !contractSha256 ||
        typeof body.pluginVersion !== "string" ||
        !oauthClientConfigSha256 ||
        registeredAppIdSha256 === undefined
      ) {
        throw exomemErrors.invalidRequest();
      }
      response = {
        stage: await createStagedClientRelease({
          candidateId,
          platform: body.platform,
          packageSha256,
          archiveSha256,
          compatibilitySha256,
          contractSha256,
          pluginVersion: body.pluginVersion,
          oauthClientConfigSha256,
          registeredAppIdSha256,
          operatorPrincipalDigest: operator.principalDigest.toString("hex"),
          expiresAt,
        }),
      };
    } else if (body.action === "expire-canary-authority") {
      response = { expired: await expireCanaryAuthority() };
    } else if (body.action === "begin-export") {
      const tenantId = uuid(body.tenantId);
      const key = idempotencyKey(body.idempotencyKey);
      if (!tenantId || !key) throw exomemErrors.invalidRequest();
      const operation = await new SqlLifecycleStore().enqueue(tenantId, "export", key);
      response = {
        operation: { id: operation.id, state: operation.state, target: operation.target },
      };
    } else if (body.action === "begin-restore") {
      const tenantId = uuid(body.tenantId);
      const exportId = uuid(body.exportId);
      const key = idempotencyKey(body.idempotencyKey);
      if (!tenantId || !exportId || !key) throw exomemErrors.invalidRequest();
      const store = new SqlLifecycleStore();
      const restoreBinding = await store.getAvailableRestoreBinding(tenantId, exportId);
      if (!restoreBinding) throw exomemErrors.invalidRequest();
      const operation = await store.enqueue(tenantId, "restore", key, null, { restoreBinding });
      response = {
        operation: { id: operation.id, state: operation.state, target: operation.target },
      };
    } else if (body.action === "fail-assignment") {
      const assignmentId = uuid(body.assignmentId);
      if (
        !assignmentId ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw exomemErrors.invalidRequest();
      response = {
        failed: await failCanaryAssignment({ assignmentId, expectedVersion: body.expectedVersion }),
      };
    } else if (body.action === "fail-stage") {
      const stagedClientReleaseId = uuid(body.stagedClientReleaseId);
      if (
        !stagedClientReleaseId ||
        typeof body.expectedVersion !== "number" ||
        !Number.isSafeInteger(body.expectedVersion) ||
        body.expectedVersion < 1
      )
        throw exomemErrors.invalidRequest();
      response = {
        failed: await failStagedClientRelease({
          stagedClientReleaseId,
          expectedVersion: body.expectedVersion,
        }),
      };
    } else if (body.action === "attach-openai-locks") {
      const candidateId = uuid(body.candidateId);
      if (
        !candidateId ||
        typeof body.operatorKeyId !== "string" ||
        typeof body.operatorSignature !== "string"
      ) {
        throw exomemErrors.invalidRequest();
      }
      response = {
        attached: await attachOpenAiContractLocks({
          candidateId,
          packageLock: body.packageLock,
          archiveLock: body.archiveLock,
          operatorKeyId: body.operatorKeyId,
          operatorSignature: body.operatorSignature,
        }),
      };
    } else if (body.action === "promote-cohort") {
      const candidateId = uuid(body.candidateId);
      const claudeArtifactId = uuid(body.claudeArtifactId);
      const openaiArtifactId = uuid(body.openaiArtifactId);
      const expectedLiveCandidateId =
        body.expectedLiveCandidateId === null ? null : uuid(body.expectedLiveCandidateId);
      const expectedRoutableCellDigest = digest(body.expectedRoutableCellDigest);
      if (
        !candidateId ||
        !claudeArtifactId ||
        !openaiArtifactId ||
        (body.expectedLiveCandidateId !== null && !expectedLiveCandidateId) ||
        !expectedRoutableCellDigest
      ) {
        throw exomemErrors.invalidRequest();
      }
      response = {
        result: await promoteExomemHostedCohort({
          candidateId,
          claudeArtifactId,
          openaiArtifactId,
          expectedLiveCandidateId,
          expectedRoutableCellDigest,
          claudeEvidence: body.claudeEvidence,
          openaiEvidence: body.openaiEvidence,
        }),
      };
    } else if (body.action === "demote-agent") {
      const candidateId = uuid(body.candidateId);
      if (!candidateId) throw exomemErrors.invalidRequest();
      response = { demoted: await demoteExomemAgentContractCandidate(candidateId) };
    } else if (body.action === "import-artifact") {
      response = { artifactId: await storeClientArtifact(body.artifact) };
    } else if (body.action === "demote-artifact") {
      const artifactId = uuid(body.artifactId);
      if (!artifactId) throw exomemErrors.invalidRequest();
      response = { demoted: await demoteOperatorClientArtifact(artifactId) };
    } else {
      throw exomemErrors.invalidRequest();
    }
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, ...response, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
