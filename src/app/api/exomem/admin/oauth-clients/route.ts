import { NextRequest, NextResponse } from "next/server";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  readOperatorJsonRecord,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";
import {
  listOperatorOAuthClients,
  refreshOperatorCimdOAuthClient,
  registerOperatorOAuthClient,
  setOperatorOAuthClientEnabled,
} from "@/lib/exomem-hosted/operator-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const clients = await listOperatorOAuthClients();
    operatorSuccessEvent(requestId);
    return NextResponse.json({
      success: true,
      clients: clients.map((client) => ({
        id: client.id,
        enabled: client.enabled,
        admissionMode: client.admissionMode,
        clientFingerprint: client.clientFingerprint,
        redirectDigest: client.redirectDigest,
        redirectCount: client.redirectCount,
        metadataExpiresAt: client.metadataExpiresAt,
      })),
      requestId,
    });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    if (!UUID.test(String(body.id)) || typeof body.enabled !== "boolean") {
      throw exomemErrors.invalidRequest();
    }
    const updated = await setOperatorOAuthClientEnabled({
      clientRecordId: body.id as string,
      enabled: body.enabled,
    });
    if (!updated) throw exomemErrors.invalidRequest();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, id: body.id, enabled: body.enabled, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    let result: { id: string; enabled: boolean };
    if (
      (body.action === "register_pinned" || body.action === "register_cimd") &&
      (body.platform === "claude" || body.platform === "openai") &&
      ((typeof body.artifactId === "string" &&
        UUID.test(body.artifactId) &&
        body.stagedClientReleaseId === undefined) ||
        (typeof body.stagedClientReleaseId === "string" &&
          UUID.test(body.stagedClientReleaseId) &&
          body.artifactId === undefined)) &&
      typeof body.clientId === "string" &&
      Array.isArray(body.redirectUris) &&
      body.redirectUris.every((redirectUri) => typeof redirectUri === "string") &&
      (body.registeredAppIdSha256 === undefined ||
        (typeof body.registeredAppIdSha256 === "string" && SHA256.test(body.registeredAppIdSha256))) &&
      (body.ttlSeconds === undefined || typeof body.ttlSeconds === "number")
    ) {
      result = await registerOperatorOAuthClient({
        admissionMode: body.action === "register_pinned" ? "pinned" : "cimd",
        platform: body.platform,
        ...(typeof body.artifactId === "string" ? { artifactId: body.artifactId } : {}),
        ...(typeof body.stagedClientReleaseId === "string"
          ? { stagedClientReleaseId: body.stagedClientReleaseId }
          : {}),
        clientId: body.clientId,
        redirectUris: body.redirectUris,
        ...(typeof body.registeredAppIdSha256 === "string"
          ? { registeredAppIdSha256: body.registeredAppIdSha256 }
          : {}),
        ttlSeconds: body.ttlSeconds as number | undefined,
      });
    } else if (
      body.action === "refresh_cimd" &&
      typeof body.id === "string" &&
      UUID.test(body.id)
    ) {
      result = await refreshOperatorCimdOAuthClient(body.id);
    } else {
      throw exomemErrors.invalidRequest();
    }
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, id: result.id, enabled: result.enabled, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
