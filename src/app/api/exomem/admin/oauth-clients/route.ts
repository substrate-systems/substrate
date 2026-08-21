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
  createReviewerOAuthBootstrapAuthority,
  listOperatorOAuthClients,
  listReviewerOAuthBootstrapAuthorities,
  preflightReusablePinnedOAuthClient,
  refreshOperatorCimdOAuthClient,
  registerOperatorOAuthClient,
  revokeReviewerOAuthBootstrapAuthority,
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
    const [clients, bootstrapAuthorities] = await Promise.all([
      listOperatorOAuthClients(),
      listReviewerOAuthBootstrapAuthorities(),
    ]);
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
      bootstrapAuthorities,
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
    const operator = await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    let result: { id: string; enabled: boolean };
    if (
      body.action === "preflight_reuse_pinned" &&
      Object.keys(body).length === 4 &&
      (body.platform === "claude" || body.platform === "openai") &&
      typeof body.clientId === "string" &&
      Array.isArray(body.redirectUris) &&
      body.redirectUris.every((redirectUri) => typeof redirectUri === "string")
    ) {
      const preflight = await preflightReusablePinnedOAuthClient({
        platform: body.platform,
        clientId: body.clientId,
        redirectUris: body.redirectUris,
      });
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, ...preflight, requestId });
    } else if (
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
        (typeof body.registeredAppIdSha256 === "string" &&
          SHA256.test(body.registeredAppIdSha256))) &&
      (body.ttlSeconds === undefined || typeof body.ttlSeconds === "number") &&
      (body.existingClientRecordId === undefined ||
        (body.action === "register_pinned" &&
          typeof body.existingClientRecordId === "string" &&
          UUID.test(body.existingClientRecordId)))
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
        ...(typeof body.existingClientRecordId === "string"
          ? { existingClientRecordId: body.existingClientRecordId }
          : {}),
        ttlSeconds: body.ttlSeconds as number | undefined,
      });
    } else if (
      body.action === "refresh_cimd" &&
      typeof body.id === "string" &&
      UUID.test(body.id)
    ) {
      result = await refreshOperatorCimdOAuthClient(body.id);
    } else if (
      body.action === "create_reviewer_bootstrap" &&
      typeof body.inviteId === "string" &&
      UUID.test(body.inviteId) &&
      typeof body.stagedClientReleaseId === "string" &&
      UUID.test(body.stagedClientReleaseId) &&
      typeof body.oauthClientId === "string" &&
      UUID.test(body.oauthClientId) &&
      typeof body.expiresAt === "string"
    ) {
      const expiresAt = new Date(body.expiresAt);
      const authority = await createReviewerOAuthBootstrapAuthority({
        inviteId: body.inviteId,
        stagedClientReleaseId: body.stagedClientReleaseId,
        oauthClientId: body.oauthClientId,
        expiresAt,
        operatorPrincipalDigest: operator.principalDigest,
      });
      if (!authority) throw exomemErrors.invalidRequest();
      operatorSuccessEvent(requestId);
      return NextResponse.json({
        success: true,
        authority: { id: authority.id, state: "active", expiresAt: authority.expiresAt },
        requestId,
      });
    } else if (
      body.action === "revoke_reviewer_bootstrap" &&
      typeof body.id === "string" &&
      UUID.test(body.id)
    ) {
      if (!(await revokeReviewerOAuthBootstrapAuthority({ authorityId: body.id }))) {
        throw exomemErrors.invalidRequest();
      }
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, id: body.id, state: "revoked", requestId });
    } else {
      throw exomemErrors.invalidRequest();
    }
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, id: result.id, enabled: result.enabled, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
