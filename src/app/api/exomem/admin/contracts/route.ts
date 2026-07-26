import { NextRequest, NextResponse } from "next/server";
import {
  attachOpenAiContractLocks,
  demoteExomemAgentContractCandidate,
  listExomemAgentContractStatus,
  promoteExomemAgentContractCandidate,
  storeExomemAgentContractCandidate,
} from "@/lib/exomem-hosted/agent-contract-store";
import { promoteClientArtifact, storeClientArtifact } from "@/lib/exomem-hosted/client-artifacts";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
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
const platform = (value: unknown): "claude" | "openai" | null =>
  value === "claude" || value === "openai" ? value : null;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const [agentContracts, clientArtifacts] = await Promise.all([
      listExomemAgentContractStatus(),
      listOperatorClientArtifacts(),
    ]);
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, agentContracts, clientArtifacts, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    let response: Record<string, unknown>;
    if (body.action === "import-agent") {
      response = { candidateId: await storeExomemAgentContractCandidate() };
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
    } else if (body.action === "promote-agent") {
      const candidateId = uuid(body.candidateId);
      const expectedRoutableCellDigest = digest(body.expectedRoutableCellDigest);
      if (!candidateId || !expectedRoutableCellDigest) throw exomemErrors.invalidRequest();
      response = {
        promoted: await promoteExomemAgentContractCandidate({
          candidateId,
          expectedRoutableCellDigest,
        }),
      };
    } else if (body.action === "demote-agent") {
      const candidateId = uuid(body.candidateId);
      if (!candidateId) throw exomemErrors.invalidRequest();
      response = { demoted: await demoteExomemAgentContractCandidate(candidateId) };
    } else if (body.action === "import-artifact") {
      response = { artifactId: await storeClientArtifact(body.artifact) };
    } else if (body.action === "promote-artifact") {
      const artifactId = uuid(body.artifactId);
      const artifactPlatform = platform(body.platform);
      if (!artifactId || !artifactPlatform) throw exomemErrors.invalidRequest();
      response = {
        promoted: await promoteClientArtifact({
          artifactId,
          platform: artifactPlatform,
          evidence: body.evidence,
        }),
      };
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
